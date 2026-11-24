//! `vcs.listRefs`, `switchRef`, `createRef`, `pull`, `init`.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::Duration,
};

use conn_contract::{
    VcsCreateRefInput, VcsCreateRefResult, VcsDriverKind, VcsInitInput, VcsListRefsInput,
    VcsListRefsInputRefKind, VcsListRefsResult, VcsPullResult, VcsPullResultStatus, VcsRef,
    VcsSwitchRefInput, VcsSwitchRefResult,
};

use crate::{
    error::{VcsError, VcsResult},
    process::{OnLimit, ProcessError},
    repo::{self, PROBE_TIMEOUT, git},
    review::METADATA_MAX_BYTES,
};

pub const DEFAULT_LIST_LIMIT: usize = 100;

struct Listed {
    reference: VcsRef,
    committed_at: i64,
}

/// `git worktree list --porcelain -z`: branch name → checkout path, for live checkouts.
pub(crate) fn parse_worktree_branches(output: &str) -> HashMap<String, PathBuf> {
    let mut map = HashMap::new();
    let (mut path, mut branch, mut prunable) = (None, None, false);
    let mut flush =
        |path: &mut Option<String>, branch: &mut Option<String>, prunable: &mut bool| {
            if let (Some(p), Some(b), false) = (path.take(), branch.take(), *prunable) {
                map.insert(b, PathBuf::from(p));
            }
            *prunable = false;
        };
    for field in output.split('\0') {
        if field.is_empty() {
            flush(&mut path, &mut branch, &mut prunable);
        } else if let Some(p) = field.strip_prefix("worktree ") {
            path = Some(p.to_owned());
        } else if let Some(b) = field.strip_prefix("branch refs/heads/") {
            branch = Some(b.to_owned());
        } else if field.starts_with("prunable") {
            prunable = true;
        }
    }
    flush(&mut path, &mut branch, &mut prunable);
    map
}

fn empty_list(is_repo: bool) -> VcsListRefsResult {
    VcsListRefsResult {
        is_at_repository_root: None,
        refs: Vec::new(),
        is_repo,
        has_primary_remote: false,
        next_cursor: None,
        total_count: 0,
    }
}

pub async fn list_refs(input: VcsListRefsInput) -> VcsResult<VcsListRefsResult> {
    let cwd = PathBuf::from(&input.cwd);
    let Some(root) = repo::toplevel(&cwd).await? else {
        return Ok(empty_list(false));
    };
    let current = repo::current_branch(&cwd).await?;
    let refs_out = git(
        "GitVcsDriver.listRefs",
        &cwd,
        [
            "for-each-ref",
            "--format=%(refname)%09%(committerdate:unix)%09%(symref)%09%(upstream)",
            "refs/heads",
            "refs/remotes",
        ],
    )
    .max_stdout(METADATA_MAX_BYTES, OnLimit::Fail)
    .text()
    .await?;
    let (worktrees, remotes, origin_default) = tokio::join!(
        git(
            "GitVcsDriver.listRefs",
            &cwd,
            ["worktree", "list", "--porcelain", "-z"]
        )
        .max_stdout(METADATA_MAX_BYTES, OnLimit::Fail)
        .run(),
        repo::remote_names(&cwd),
        repo::remote_default_branch(&cwd, "origin"),
    );
    let worktrees = worktrees
        .map(|o| parse_worktree_branches(&o.stdout_text()))
        .unwrap_or_default();
    let worktrees: HashMap<String, PathBuf> =
        worktrees.into_iter().filter(|(_, p)| p.exists()).collect();
    let mut remotes = remotes.unwrap_or_default();
    remotes.sort_by_key(|r| std::cmp::Reverse(r.len()));
    let default_branch = origin_default.unwrap_or(None);
    let root_text = root.to_string_lossy().into_owned();

    let mut local = Vec::new();
    let mut remote = Vec::new();
    for line in refs_out.lines() {
        let mut parts = line.split('\t');
        let (Some(full), Some(date), symref, upstream) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        if symref.is_some_and(|s| !s.is_empty()) {
            continue;
        }
        let committed_at = date.parse().unwrap_or(0);
        if let Some(name) = full.strip_prefix("refs/heads/") {
            let mut worktree_path = worktrees
                .get(name)
                .map(|p| p.to_string_lossy().into_owned());
            if worktree_path.is_none() && current.as_deref() == Some(name) {
                worktree_path = Some(root_text.clone());
            }
            local.push(Listed {
                reference: VcsRef {
                    name: name.to_owned(),
                    is_remote: Some(false),
                    remote_name: None,
                    upstream_ref: upstream.filter(|u| !u.is_empty()).map(str::to_owned),
                    current: false,
                    is_default: default_branch.as_deref() == Some(name),
                    worktree_path,
                },
                committed_at,
            });
        } else if let Some(name) = full.strip_prefix("refs/remotes/") {
            let remote_name = remotes
                .iter()
                .find(|r| name.starts_with(&format!("{r}/")))
                .cloned();
            let is_default = remote_name.as_deref() == Some("origin")
                && name.strip_prefix("origin/") == default_branch.as_deref();
            remote.push(Listed {
                reference: VcsRef {
                    name: name.to_owned(),
                    is_remote: Some(true),
                    remote_name,
                    upstream_ref: None,
                    current: false,
                    is_default,
                    worktree_path: None,
                },
                committed_at,
            });
        }
    }
    for group in [&mut local, &mut remote] {
        group.sort_by(|a, b| {
            b.committed_at
                .cmp(&a.committed_at)
                .then_with(|| a.reference.name.cmp(&b.reference.name))
        });
    }
    let has_current_worktree_branch = local
        .iter()
        .any(|r| r.reference.worktree_path.as_deref() == Some(root_text.as_str()));
    for listed in &mut local {
        listed.reference.current = if has_current_worktree_branch {
            listed.reference.worktree_path.as_deref() == Some(root_text.as_str())
        } else {
            current.as_deref() == Some(listed.reference.name.as_str())
        };
    }
    let local_names: Vec<String> = local.iter().map(|r| r.reference.name.clone()).collect();
    let mut refs: Vec<VcsRef> = local.into_iter().map(|l| l.reference).collect();
    refs.extend(remote.into_iter().map(|l| l.reference).filter(|r| {
        input.include_matching_remote_refs == Some(true)
            || r.remote_name.as_deref() != Some("origin")
            || !r
                .name
                .split_once('/')
                .is_some_and(|(_, branch)| local_names.iter().any(|l| l == branch))
    }));
    refs.sort_by_key(|r| {
        if r.current {
            0
        } else if r.is_default {
            1
        } else {
            2
        }
    });
    match input.ref_kind {
        Some(VcsListRefsInputRefKind::Local) => refs.retain(|r| r.is_remote != Some(true)),
        Some(VcsListRefsInputRefKind::Remote) => refs.retain(|r| r.is_remote == Some(true)),
        _ => {}
    }
    if let Some(query) = input.query.as_deref().map(str::to_lowercase) {
        refs.retain(|r| r.name.to_lowercase().contains(&query));
    }
    let total = refs.len();
    let cursor = input.cursor.unwrap_or(0).max(0) as usize;
    let limit = input
        .limit
        .map_or(DEFAULT_LIST_LIMIT, |l| l.clamp(1, 200) as usize);
    let page: Vec<VcsRef> = refs.into_iter().skip(cursor).take(limit).collect();
    let end = cursor + page.len();
    let real_cwd = std::fs::canonicalize(&cwd).ok();
    let real_root = std::fs::canonicalize(&root).ok();
    Ok(VcsListRefsResult {
        is_at_repository_root: match (real_cwd, real_root) {
            (Some(c), Some(r)) => Some(c == r),
            _ => None,
        },
        refs: page,
        is_repo: true,
        has_primary_remote: !remotes.is_empty(),
        next_cursor: (end < total).then_some(end as i64),
        total_count: total as i64,
    })
}

fn refuse_option_like(operation: &'static str, cwd: &Path, name: &str) -> VcsResult<()> {
    if name.starts_with('-') && name != "-" {
        return Err(VcsError::invalid(
            operation,
            &cwd.to_string_lossy(),
            "Ref names cannot start with '-'.",
        ));
    }
    Ok(())
}

pub async fn switch_ref(input: VcsSwitchRefInput) -> VcsResult<VcsSwitchRefResult> {
    let cwd = PathBuf::from(&input.cwd);
    let name = input.ref_name.as_str();
    let (local_ref, remote_ref) = (format!("refs/heads/{name}"), format!("refs/remotes/{name}"));
    let (local, remote) = tokio::join!(
        repo::ref_exists(&cwd, &local_ref),
        repo::ref_exists(&cwd, &remote_ref),
    );
    let (local, remote) = (local?, remote?);
    let mut target = name.to_owned();
    let mut track = false;
    if !local && remote {
        let tracking = git(
            "GitVcsDriver.switchRef",
            &cwd,
            [
                "for-each-ref",
                "--format=%(refname:lstrip=2)\t%(upstream)",
                "refs/heads",
            ],
        )
        .timeout(PROBE_TIMEOUT)
        .text()
        .await?;
        let remote_ref = format!("refs/remotes/{name}");
        let tracking = tracking
            .lines()
            .filter_map(|l| l.split_once('\t'))
            .find(|(_, upstream)| *upstream == remote_ref)
            .map(|(branch, _)| branch.to_owned());
        if let Some(branch) = tracking {
            target = branch;
        } else {
            let candidate = name.split_once('/').map_or(name, |(_, b)| b).to_owned();
            if repo::ref_exists(&cwd, &format!("refs/heads/{candidate}")).await? {
                track = true;
            } else {
                git(
                    "GitVcsDriver.switchRef",
                    &cwd,
                    [
                        "branch",
                        "--no-track",
                        "--",
                        candidate.as_str(),
                        remote_ref.as_str(),
                    ],
                )
                .run()
                .await?;
                let upstream = format!("--set-upstream-to={remote_ref}");
                if let Err(e) = git(
                    "GitVcsDriver.switchRef",
                    &cwd,
                    ["branch", upstream.as_str(), "--", candidate.as_str()],
                )
                .run()
                .await
                {
                    let _ = git(
                        "GitVcsDriver.switchRef",
                        &cwd,
                        [
                            "update-ref",
                            "-d",
                            &format!("refs/heads/{candidate}"),
                            remote_ref.as_str(),
                        ],
                    )
                    .run()
                    .await;
                    return Err(e.into());
                }
                target = candidate;
            }
        }
    }
    refuse_option_like("GitVcsDriver.switchRef", &cwd, &target)?;
    let mut args = vec!["checkout".to_owned()];
    if track {
        args.push("--track".into());
    }
    args.push(target);
    args.push("--".into());
    git("GitVcsDriver.switchRef", &cwd, args)
        .timeout(Duration::from_secs(600))
        .run()
        .await?;
    let current = git("GitVcsDriver.switchRef", &cwd, ["branch", "--show-current"])
        .text()
        .await?;
    let current = current.trim();
    Ok(VcsSwitchRefResult {
        ref_name: (!current.is_empty()).then(|| current.to_owned()),
    })
}

pub async fn create_ref(input: VcsCreateRefInput) -> VcsResult<VcsCreateRefResult> {
    let cwd = PathBuf::from(&input.cwd);
    git(
        "GitVcsDriver.createRef",
        &cwd,
        ["branch", "--", input.ref_name.as_str()],
    )
    .timeout(Duration::from_secs(10))
    .run()
    .await?;
    if input.switch_ref == Some(true) {
        switch_ref(VcsSwitchRefInput {
            cwd: input.cwd.clone(),
            ref_name: input.ref_name.clone(),
        })
        .await?;
    }
    Ok(VcsCreateRefResult {
        ref_name: input.ref_name,
    })
}

pub async fn pull(cwd: &Path) -> VcsResult<VcsPullResult> {
    let fail = |detail: &str| {
        VcsError::invalid(
            "GitVcsDriver.pullCurrentBranch",
            &cwd.to_string_lossy(),
            detail,
        )
    };
    let Some(branch) = repo::current_branch(cwd).await? else {
        return Err(fail("Cannot pull from detached HEAD."));
    };
    let upstream = repo::optional_text(git(
        "GitVcsDriver.pullCurrentBranch",
        cwd,
        [
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    ))
    .await?
    .filter(|u| !u.is_empty());
    let Some(upstream) = upstream else {
        return Err(fail(
            "Current branch has no upstream configured. Push with upstream first.",
        ));
    };
    let head = || async {
        repo::optional_text(git(
            "GitVcsDriver.pullCurrentBranch",
            cwd,
            ["rev-parse", "HEAD"],
        ))
        .await
        .map(Option::unwrap_or_default)
    };
    let before = head().await?;
    let sole_upstream = sole_upstream(cwd, &branch).await?;
    let run_pull = |args: Vec<String>| {
        git("GitVcsDriver.pullCurrentBranch.pull", cwd, args)
            .timeout(Duration::from_secs(600))
            .max_stdout(1_000_000, OnLimit::Truncate)
            .env("GCM_INTERACTIVE", "never")
            .env("GIT_ASKPASS", "")
            .env("SSH_ASKPASS", "")
            .env("SSH_ASKPASS_REQUIRE", "never")
            .run()
    };
    if let Err(error) = run_pull(vec!["pull".into(), "--ff-only".into()]).await {
        // A full fetch fails on any branch's ref lock. Then retry only the upstream captured
        // before it, while nothing has moved the branch, HEAD or upstream. Git's lock stays.
        let retry = match (&error, sole_upstream) {
            (ProcessError::Exit { stderr, .. }, Some(upstream)) if is_ref_lock_failure(stderr) => {
                unmoved(cwd, &branch, &before, &upstream)
                    .await?
                    .then_some(upstream)
            }
            _ => None,
        };
        let Some((remote, merge_ref)) = retry else {
            return Err(error.into());
        };
        run_pull(vec![
            "pull".into(),
            "--ff-only".into(),
            "--".into(),
            remote,
            merge_ref,
        ])
        .await?;
    }
    let after = head().await?;
    Ok(VcsPullResult {
        status: if !before.is_empty() && before == after {
            VcsPullResultStatus::SkippedUpToDate
        } else {
            VcsPullResultStatus::Pulled
        },
        ref_name: branch,
        upstream_ref: Some(upstream),
    })
}

/// The branch's remote and merge ref, when exactly one merge ref is configured.
async fn sole_upstream(cwd: &Path, branch: &str) -> VcsResult<Option<(String, String)>> {
    let remote = repo::config_get(cwd, &format!("branch.{branch}.remote")).await?;
    let merge_refs = repo::optional_text(git(
        "GitVcsDriver.pullCurrentBranch.mergeRefs",
        cwd,
        [
            "config".to_owned(),
            "--get-all".into(),
            format!("branch.{branch}.merge"),
        ],
    ))
    .await?
    .unwrap_or_default();
    let mut merge_refs = merge_refs.lines().filter(|line| !line.is_empty());
    Ok(match (remote, merge_refs.next(), merge_refs.next()) {
        (Some(remote), Some(merge_ref), None) => Some((remote, merge_ref.to_owned())),
        _ => None,
    })
}

/// Whether `branch` is still checked out at `before` with the same sole upstream.
async fn unmoved(
    cwd: &Path,
    branch: &str,
    before: &str,
    upstream: &(String, String),
) -> VcsResult<bool> {
    if sole_upstream(cwd, branch).await?.as_ref() != Some(upstream)
        || repo::current_branch(cwd).await?.as_deref() != Some(branch)
    {
        return Ok(false);
    }
    let current_sha = repo::optional_text(git(
        "GitVcsDriver.pullCurrentBranch.currentSha",
        cwd,
        ["rev-parse", "HEAD"],
    ))
    .await?;
    Ok(current_sha.as_deref() == Some(before))
}

/// Git reports a ref it could not lock as `cannot lock ref` before 2.53, and as a fetching-ref
/// failure after.
fn is_ref_lock_failure(stderr: &str) -> bool {
    stderr.lines().any(|line| {
        let line = line.trim().to_ascii_lowercase();
        let after_level = line
            .strip_prefix("error: ")
            .or_else(|| line.strip_prefix("fatal: "));
        let cannot_lock = after_level
            .and_then(|rest| rest.strip_prefix("cannot lock ref"))
            .is_some_and(|rest| !rest.starts_with(|c: char| c.is_alphanumeric() || c == '_'));
        let create_lock = line
            .strip_prefix("fatal: unable to create ")
            .is_some_and(|rest| {
                rest.starts_with(['\'', '"'])
                    && (rest.contains(".lock':") || rest.contains(".lock\":"))
            });
        let fetching_ref = line
            .strip_prefix("error: fetching ref ")
            .is_some_and(|rest| {
                rest.ends_with(" failed: incorrect old value provided")
                    || rest.ends_with(" failed: reference already exists")
            });
        cannot_lock || create_lock || fetching_ref
    })
}

pub async fn init(input: VcsInitInput) -> VcsResult<()> {
    match input.kind {
        None | Some(VcsDriverKind::Git) => {}
        Some(VcsDriverKind::Jj) => {
            return Err(VcsError::Unsupported {
                operation: "VcsDriverRegistry.get",
                kind: VcsDriverKind::Jj,
                detail: "No jj VCS driver is registered.".into(),
            });
        }
        Some(VcsDriverKind::Unknown) => {
            return Err(VcsError::Unsupported {
                operation: "VcsProvisioningService.resolveRequestedKind",
                kind: VcsDriverKind::Unknown,
                detail: "A concrete VCS driver kind is required for repository provisioning."
                    .into(),
            });
        }
    }
    let cwd = PathBuf::from(&input.cwd);
    match git("GitVcsDriver.initRepository", &cwd, ["init"])
        .timeout(Duration::from_secs(10))
        .max_stdout(64 * 1024, OnLimit::Truncate)
        .run()
        .await
    {
        Ok(_) => Ok(()),
        Err(e @ ProcessError::Exit { .. }) => Err(e.into()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// T3 "does not retry a failed fetch if another operation moved branch/HEAD", plus a
    /// retargeted upstream.
    #[tokio::test]
    async fn retry_needs_the_same_branch_head_and_upstream() {
        let dir =
            std::env::temp_dir().join(format!("conn-vcs-upstream-only-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid"])
                .args(["-c", "commit.gpgsign=false"])
                .args(args)
                .current_dir(&dir)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}");
            String::from_utf8_lossy(&out.stdout).trim().to_owned()
        };
        run(&["init", "-q", "-b", "main"]);
        run(&["commit", "-q", "--allow-empty", "-m", "base"]);
        run(&["config", "branch.main.remote", "origin"]);
        run(&["config", "branch.main.merge", "refs/heads/main"]);
        let head = run(&["rev-parse", "HEAD"]);
        let upstream = sole_upstream(&dir, "main").await.unwrap().unwrap();
        assert_eq!(upstream, ("origin".into(), "refs/heads/main".into()));
        let unmoved = |sha: String| {
            let (dir, upstream) = (dir.clone(), upstream.clone());
            async move { unmoved(&dir, "main", &sha, &upstream).await.unwrap() }
        };

        assert!(unmoved(head.clone()).await);
        run(&["config", "branch.main.merge", "refs/heads/other"]);
        assert!(!unmoved(head.clone()).await, "merge ref retargeted");
        run(&["config", "branch.main.merge", "refs/heads/main"]);
        run(&["config", "branch.main.remote", "fork"]);
        assert!(!unmoved(head.clone()).await, "remote retargeted");
        run(&["config", "branch.main.remote", "origin"]);
        run(&["commit", "-q", "--allow-empty", "-m", "concurrent commit"]);
        assert!(!unmoved(head).await, "HEAD moved");
        let head = run(&["rev-parse", "HEAD"]);
        run(&["checkout", "-q", "-b", "moved"]);
        assert!(!unmoved(head.clone()).await, "branch moved");
        run(&["checkout", "-q", "main"]);
        run(&["config", "--add", "branch.main.merge", "refs/heads/other"]);
        assert_eq!(sole_upstream(&dir, "main").await.unwrap(), None);
        assert!(!unmoved(head).await, "two upstream refs");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ref_lock_failures_match_t3() {
        for stderr in [
            "error: cannot lock ref 'refs/remotes/origin/other': Unable to create '/r/.git/refs/remotes/origin/other.lock': File exists.",
            "fatal: Unable to create '/r/.git/refs/remotes/origin/main.lock': File exists.",
            "error: fetching ref refs/remotes/origin/other failed: incorrect old value provided",
            "From /r/origin\n error: fetching ref refs/remotes/origin/x failed: reference already exists\n",
        ] {
            assert!(is_ref_lock_failure(stderr), "{stderr}");
        }
        for stderr in [
            "fatal: Not possible to fast-forward, aborting.",
            "error: cannot lock refsx",
            "fatal: Unable to create '/r/.git/index.lock'",
            "hint: cannot lock ref",
        ] {
            assert!(!is_ref_lock_failure(stderr), "{stderr}");
        }
    }

    #[test]
    fn worktree_porcelain_skips_prunable_and_detached() {
        let out = "worktree /repo\0HEAD abc\0branch refs/heads/main\0\0\
                   worktree /wt/a\0HEAD def\0branch refs/heads/feature/a\0\0\
                   worktree /wt/b\0HEAD 123\0detached\0\0\
                   worktree /wt/c\0HEAD 456\0branch refs/heads/gone\0prunable gitdir file points to non-existent location\0\0";
        let map = parse_worktree_branches(out);
        assert_eq!(map.len(), 2);
        assert_eq!(map["feature/a"], PathBuf::from("/wt/a"));
        assert_eq!(map["main"], PathBuf::from("/repo"));
    }
}
