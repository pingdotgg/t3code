//! Worktrees: create from a ref, list, remove. Used by `vcs.createWorktree` /
//! `vcs.removeWorktree` and by thread launch with a worktree strategy (see [`crate::setup`]).
//!
//! Paths follow `GitVcsDriverCore.createWorktree`: `<worktrees dir>/<repo>/<branch>-<hash16>`,
//! where the hash is `sha256(<git common dir> NUL <branch>)`.

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use sha2::{Digest, Sha256};

use crate::{
    error::{VcsError, VcsResult},
    process::{OnLimit, ProcessError},
    refs::parse_worktree_branches,
    repo::{self, git},
};

const OPERATION: &str = "GitVcsDriver.createWorktree";
/// Branch name prefix kept in a worktree folder name, in UTF-8 bytes.
const PREFIX_MAX_BYTES: usize = 23;
pub const REMOVE_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreateWorktree {
    /// A folder inside the repository the worktree belongs to.
    pub cwd: PathBuf,
    /// The ref to check out, or the start point when `new_ref_name` is set.
    pub ref_name: String,
    /// A branch to create at `ref_name` and check out.
    pub new_ref_name: Option<String>,
    /// Recorded as the new branch's base (`branch.<new>.t3-merge-base`), for Changes totals.
    pub base_ref_name: Option<String>,
    /// Where managed worktrees live: `<state dir>/worktrees`.
    pub worktrees_dir: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Worktree {
    pub path: PathBuf,
    /// The branch checked out there; `None` when detached.
    pub ref_name: Option<String>,
}

fn invalid(cwd: &Path, detail: impl Into<String>) -> VcsError {
    VcsError::invalid(OPERATION, &cwd.to_string_lossy(), detail)
}

fn refuse_option_like(cwd: &Path, name: &str) -> VcsResult<()> {
    if name.starts_with('-') && name != "-" {
        return Err(invalid(cwd, "Ref names cannot start with '-'."));
    }
    Ok(())
}

/// The folder name for `branch`: slashes become dashes, at most 23 bytes, then a hash.
pub fn worktree_folder_name(common_dir: &str, branch: &str) -> String {
    let mut prefix = String::new();
    for c in branch.replace('/', "-").chars() {
        if prefix.len() + c.len_utf8() > PREFIX_MAX_BYTES {
            break;
        }
        prefix.push(c);
    }
    let digest = Sha256::digest(format!("{common_dir}\0{branch}").as_bytes());
    let hash = conn_support::hex::hex(digest.get(..8).unwrap_or_default());
    format!("{prefix}-{hash}")
}

async fn common_dir(cwd: &Path) -> VcsResult<PathBuf> {
    let raw = git(OPERATION, cwd, ["rev-parse", "--git-common-dir"])
        .timeout(repo::PROBE_TIMEOUT)
        .text()
        .await?;
    let path = cwd.join(raw.trim());
    tokio::task::spawn_blocking(move || std::fs::canonicalize(&path).unwrap_or(path))
        .await
        .map_err(|e| invalid(cwd, e.to_string()))
}

/// The managed path for a new worktree of `branch`, `-2`, `-3`, ... when taken.
pub async fn managed_path(cwd: &Path, branch: &str, worktrees_dir: &Path) -> VcsResult<PathBuf> {
    if !worktrees_dir.is_absolute() || worktrees_dir.parent().is_none() {
        return Err(invalid(
            cwd,
            format!(
                "The worktree location \"{}\" must be an absolute folder on this machine, not a drive root.",
                worktrees_dir.display()
            ),
        ));
    }
    let common = common_dir(cwd).await?;
    let cwd_for_error = cwd;
    let cwd = cwd.to_owned();
    let worktrees_dir = worktrees_dir.to_owned();
    let branch = branch.to_owned();
    tokio::task::spawn_blocking(move || {
        let repo_name = std::path::absolute(&cwd)
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_owned()))
            .unwrap_or_else(|| "repo".into());
        let base = worktrees_dir
            .join(repo_name)
            .join(worktree_folder_name(&common.to_string_lossy(), &branch));
        let mut path = base.clone();
        let mut n = 2_u64;
        while path.exists() {
            path = PathBuf::from(format!("{}-{n}", base.display()));
            n += 1;
        }
        Ok(path)
    })
    .await
    .map_err(|e| invalid(cwd_for_error, e.to_string()))?
}

/// Creates a worktree at the managed path and returns it. With `new_ref_name`, creates that
/// branch at `ref_name` first (tracking it when it is a remote branch) and removes it again if
/// the checkout fails.
pub async fn create_worktree(input: &CreateWorktree) -> VcsResult<Worktree> {
    let cwd = input.cwd.as_path();
    refuse_option_like(cwd, &input.ref_name)?;
    if let Some(new) = &input.new_ref_name {
        refuse_option_like(cwd, new)?;
    }
    let target = input
        .new_ref_name
        .clone()
        .unwrap_or_else(|| input.ref_name.clone());
    let path = managed_path(cwd, &target, &input.worktrees_dir).await?;
    let start = if input.ref_name == "-" {
        "@{-1}".to_owned()
    } else {
        input.ref_name.clone()
    };

    if let Some(new) = &input.new_ref_name {
        git(
            OPERATION,
            cwd,
            ["branch", "--no-track", "--", new.as_str(), start.as_str()],
        )
        .run()
        .await?;
        if let Ok(Some(full)) = repo::optional_text(git(
            OPERATION,
            cwd,
            ["rev-parse", "--symbolic-full-name", start.as_str()],
        ))
        .await
            && full.starts_with("refs/remotes/")
        {
            let upstream = format!("--set-upstream-to={full}");
            let _ = git(
                OPERATION,
                cwd,
                ["branch", upstream.as_str(), "--", new.as_str()],
            )
            .run()
            .await;
        }
    }

    let workers = repo::config_get(cwd, "checkout.workers")
        .await
        .unwrap_or(None)
        .unwrap_or_else(|| "0".into());
    let added = git(
        OPERATION,
        cwd,
        [
            "-c".to_owned(),
            format!("checkout.workers={workers}"),
            "worktree".into(),
            "add".into(),
            "--".into(),
            path.to_string_lossy().into_owned(),
            target.clone(),
        ],
    )
    .timeout(Duration::from_secs(3600))
    .max_stdout(1_000_000, OnLimit::Truncate)
    .run()
    .await;
    if let Err(error) = added {
        if let Some(new) = &input.new_ref_name {
            let _ = git(OPERATION, cwd, ["branch", "-D", "--", new.as_str()])
                .run()
                .await;
        }
        return Err(error.into());
    }

    if let (Some(new), Some(base)) = (&input.new_ref_name, &input.base_ref_name)
        && let Some((branch_name, full)) = resolve_branch_base(cwd, base).await
    {
        let _ = git(
            OPERATION,
            cwd,
            [
                "config".to_owned(),
                format!("branch.{new}.t3-merge-base"),
                branch_name,
            ],
        )
        .run()
        .await;
        if full.starts_with("refs/remotes/") {
            let _ = git(
                OPERATION,
                cwd,
                [
                    "config".to_owned(),
                    format!("branch.{new}.t3-merge-base-ref"),
                    full,
                ],
            )
            .run()
            .await;
        }
    }
    Ok(Worktree {
        path,
        ref_name: Some(target),
    })
}

/// `(branch name, full ref)` of a base given as a local or remote branch.
async fn resolve_branch_base(cwd: &Path, base: &str) -> Option<(String, String)> {
    let full = match repo::optional_text(git(
        OPERATION,
        cwd,
        [
            "rev-parse",
            "--symbolic-full-name",
            "--verify",
            "--end-of-options",
            base,
        ],
    ))
    .await
    .ok()
    .flatten()
    .filter(|f| !f.is_empty())
    {
        Some(full) => full,
        None => {
            let remote = repo::primary_remote(cwd).await.ok().flatten()?;
            let candidate = format!("refs/remotes/{remote}/{base}");
            repo::ref_exists(cwd, &candidate)
                .await
                .ok()?
                .then_some(candidate)?
        }
    };
    if let Some(branch) = full.strip_prefix("refs/heads/") {
        return Some((branch.to_owned(), full.clone()));
    }
    let rest = full.strip_prefix("refs/remotes/")?;
    let mut remotes = repo::remote_names(cwd).await.ok()?;
    remotes.sort_by_key(|r| std::cmp::Reverse(r.len()));
    let branch = remotes
        .iter()
        .find_map(|r| rest.strip_prefix(&format!("{r}/")))
        .unwrap_or(rest)
        .to_owned();
    Some((branch, full))
}

/// Whether git may discard local changes (and, for a branch, unmerged commits).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Removal {
    /// Refuse when something would be lost.
    Safe,
    /// Remove anyway (`--force`, `branch -D`).
    Force,
}

/// Removes a worktree. Never removes a locked one. A worktree git no longer knows and whose
/// folder is gone counts as removed (after `git worktree prune`). The branch is kept.
pub async fn remove_worktree(cwd: &Path, path: &Path, removal: Removal) -> VcsResult<()> {
    let target = if path.is_absolute() {
        path.to_owned()
    } else {
        cwd.join(path)
    };
    let mut args = vec![
        "-c".to_owned(),
        "status.showUntrackedFiles=normal".into(),
        "worktree".into(),
        "remove".into(),
    ];
    if removal == Removal::Force {
        args.push("--force".into());
    }
    args.push("--".into());
    args.push(target.to_string_lossy().into_owned());
    match git("GitVcsDriver.removeWorktree", cwd, args)
        .timeout(REMOVE_TIMEOUT)
        .run()
        .await
    {
        Ok(_) => Ok(()),
        Err(ProcessError::Exit { stderr, .. })
            if !path_exists(&target).await? && {
                let s = stderr.to_ascii_lowercase();
                s.contains("is not a working tree") || s.contains("cannot remove working tree")
            } =>
        {
            git("GitVcsDriver.removeWorktree", cwd, ["worktree", "prune"])
                .timeout(Duration::from_secs(15))
                .run()
                .await?;
            Ok(())
        }
        Err(e) => Err(e.into()),
    }
}

async fn path_exists(path: &Path) -> VcsResult<bool> {
    let target = path.to_owned();
    tokio::task::spawn_blocking(move || target.exists())
        .await
        .map_err(|e| invalid(path, e.to_string()))
}

/// Deletes a local branch (`git branch -d`, or `-D` with `force`).
pub async fn delete_branch(cwd: &Path, branch: &str, removal: Removal) -> VcsResult<()> {
    git(
        "GitVcsDriver.deleteLocalBranch",
        cwd,
        [
            "branch",
            if removal == Removal::Force {
                "-D"
            } else {
                "-d"
            },
            "--",
            branch,
        ],
    )
    .timeout(Duration::from_secs(10))
    .run()
    .await?;
    Ok(())
}

/// Every live worktree of the repository, the main checkout first.
pub async fn list_worktrees(cwd: &Path) -> VcsResult<Vec<Worktree>> {
    let out = git(
        "GitVcsDriver.listWorktrees",
        cwd,
        ["worktree", "list", "--porcelain", "-z"],
    )
    .text()
    .await?;
    let branches = parse_worktree_branches(&out);
    let mut list = Vec::new();
    for field in out.split('\0') {
        if let Some(path) = field.strip_prefix("worktree ") {
            let path = PathBuf::from(path);
            let ref_name = branches
                .iter()
                .find(|(_, p)| **p == path)
                .map(|(b, _)| b.clone());
            list.push(Worktree { path, ref_name });
        }
    }
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_name_truncates_by_bytes_and_hashes() {
        let name = worktree_folder_name("/repo/.git", "feature/a-very-long-branch-name");
        let (prefix, hash) = name.rsplit_once('-').unwrap();
        assert_eq!(prefix, "feature-a-very-long-bra");
        assert_eq!(hash.len(), 16);
        // node -e 'console.log(require("crypto").createHash("sha256").update("/repo/.git\0t3/abc").digest("hex").slice(0,16))'
        assert_eq!(
            worktree_folder_name("/repo/.git", "t3/abc"),
            "t3-abc-23ec9f9fd335214f"
        );
        let multi = worktree_folder_name("/r", "ééééééééééééé");
        assert!(multi.split('-').next().unwrap().len() <= PREFIX_MAX_BYTES);
    }
}
