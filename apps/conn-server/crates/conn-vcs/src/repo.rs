//! Small reads every area shares: the repository root, the current branch, remotes, and the
//! base a branch compares against.

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use crate::{
    error::{VcsError, VcsResult},
    process::{GitCommand, ProcessError},
};

pub(crate) const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) fn git<I, S>(operation: &'static str, cwd: &Path, args: I) -> GitCommand
where
    I: IntoIterator<Item = S>,
    S: Into<std::ffi::OsString>,
{
    GitCommand::new(operation, cwd, args)
}

/// Runs and reports only whether git exited 0. A git that cannot start is an error.
pub(crate) async fn succeeds(command: GitCommand) -> VcsResult<bool> {
    match command.run().await {
        Ok(_) => Ok(true),
        Err(ProcessError::Exit { .. }) => Ok(false),
        Err(e) => Err(e.into()),
    }
}

/// Runs and returns trimmed stdout, or `None` on a non-zero exit.
pub(crate) async fn optional_text(command: GitCommand) -> VcsResult<Option<String>> {
    match command.run().await {
        Ok(out) => {
            let text = out.stdout_text().trim().to_owned();
            Ok(Some(text))
        }
        Err(ProcessError::Exit { .. }) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// The work tree root, or `None` for a folder outside a repository (or a missing folder).
pub async fn toplevel(cwd: &Path) -> VcsResult<Option<PathBuf>> {
    if !cwd.is_dir() {
        return Ok(None);
    }
    let root = optional_text(
        git(
            "GitVcsDriver.repositoryRoot",
            cwd,
            ["rev-parse", "--show-toplevel"],
        )
        .timeout(PROBE_TIMEOUT),
    )
    .await?;
    Ok(root.filter(|r| !r.is_empty()).map(PathBuf::from))
}

/// The checked-out branch name, `None` when HEAD is detached or the folder is no checkout.
pub async fn current_branch(cwd: &Path) -> VcsResult<Option<String>> {
    if !cwd.is_dir() {
        return Ok(None);
    }
    let head = optional_text(
        git(
            "GitVcsDriver.currentBranch",
            cwd,
            ["symbolic-ref", "--quiet", "HEAD"],
        )
        .timeout(PROBE_TIMEOUT),
    )
    .await?;
    Ok(head.and_then(|h| h.strip_prefix("refs/heads/").map(str::to_owned)))
}

/// The `HEAD` file of the checkout (for a linked worktree, inside its own git folder).
pub async fn head_path(cwd: &Path) -> VcsResult<Option<PathBuf>> {
    if !cwd.is_dir() {
        return Ok(None);
    }
    let path = optional_text(
        git(
            "GitVcsDriver.headPath",
            cwd,
            ["rev-parse", "--path-format=absolute", "--git-path", "HEAD"],
        )
        .timeout(PROBE_TIMEOUT),
    )
    .await?;
    Ok(path.filter(|p| !p.is_empty()).map(PathBuf::from))
}

pub async fn ref_exists(cwd: &Path, full_ref: &str) -> VcsResult<bool> {
    succeeds(
        git(
            "GitVcsDriver.refExists",
            cwd,
            ["show-ref", "--verify", "--quiet", full_ref],
        )
        .timeout(PROBE_TIMEOUT),
    )
    .await
}

pub async fn has_head_commit(cwd: &Path) -> VcsResult<bool> {
    succeeds(git(
        "GitVcsDriver.hasHead",
        cwd,
        ["rev-parse", "--verify", "--quiet", "HEAD"],
    ))
    .await
}

pub async fn config_get(cwd: &Path, key: &str) -> VcsResult<Option<String>> {
    Ok(optional_text(git(
        "GitVcsDriver.readConfigValue",
        cwd,
        ["config", "--get", key],
    ))
    .await?
    .filter(|v| !v.is_empty()))
}

pub async fn remote_names(cwd: &Path) -> VcsResult<Vec<String>> {
    Ok(
        optional_text(git("GitVcsDriver.listRemoteNames", cwd, ["remote"]))
            .await?
            .map(|s| {
                s.lines()
                    .map(str::trim)
                    .filter(|l| !l.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
    )
}

/// `findRemoteTrackingRemote`: the remote that has `refs/remotes/<remote>/<branch>`; the
/// preferred remote first, then `origin`, then the first in `git remote` order.
pub async fn remote_tracking_remote(
    cwd: &Path,
    branch: &str,
    preferred: Option<&str>,
) -> VcsResult<Option<String>> {
    if branch.is_empty() {
        return Ok(None);
    }
    let names = remote_names(cwd).await?;
    if names.is_empty() {
        return Ok(None);
    }
    let mut args = vec!["for-each-ref".to_owned(), "--format=%(refname)".to_owned()];
    args.extend(names.iter().map(|n| format!("refs/remotes/{n}/{branch}")));
    let refs = optional_text(
        git("GitManager.findRemoteTrackingRemote.refs", cwd, args).timeout(PROBE_TIMEOUT),
    )
    .await?
    .unwrap_or_default();
    let refs: Vec<&str> = refs.lines().map(str::trim).collect();
    let matching: Vec<&String> = names
        .iter()
        .filter(|n| refs.contains(&format!("refs/remotes/{n}/{branch}").as_str()))
        .collect();
    if let Some(preferred) = preferred
        && matching.iter().any(|n| *n == preferred)
    {
        return Ok(Some(preferred.to_owned()));
    }
    if matching.iter().any(|n| *n == "origin") {
        return Ok(Some("origin".to_owned()));
    }
    Ok(matching.first().map(|n| (*n).clone()))
}

/// `findPublishedBranchRemote`: the one remote a branch without an upstream was pushed to.
/// A remote whose `refs/remotes/<remote>/<branch>` is the local commit wins; else the one
/// whose ref is an ancestor of it. Without a local branch, the one remote that tracks
/// `branch`. Two candidates, or none, answer `None`.
pub async fn published_branch_remote(cwd: &Path, branch: &str) -> VcsResult<Option<String>> {
    let names = remote_names(cwd).await?;
    if names.is_empty() {
        return Ok(None);
    }
    let local_ref = format!("refs/heads/{branch}");
    let mut args = vec![
        "for-each-ref".to_owned(),
        "--format=%(refname)%00%(objectname)".to_owned(),
        local_ref.clone(),
    ];
    args.extend(names.iter().map(|n| format!("refs/remotes/{n}/{branch}")));
    let listing = optional_text(
        git("GitManager.findPublishedBranchRemote", cwd, args).timeout(PROBE_TIMEOUT),
    )
    .await?
    .unwrap_or_default();
    let oids: Vec<(&str, &str)> = listing
        .lines()
        .filter_map(|line| line.trim().split_once('\0'))
        .collect();
    let oid_of = |reference: &str| oids.iter().find(|(r, _)| *r == reference).map(|(_, o)| *o);
    let remote_refs: Vec<(&String, &str)> = names
        .iter()
        .filter_map(|n| oid_of(&format!("refs/remotes/{n}/{branch}")).map(|o| (n, o)))
        .collect();
    let Some(local) = oid_of(&local_ref) else {
        // No local branch (deleted after the push): the one remote that tracks it, as T3's
        // `branchPullRequest.remoteTrackingRefs`. Several are ambiguous.
        let [(name, _)] = remote_refs.as_slice() else {
            return Ok(None);
        };
        return Ok(config_get(cwd, &format!("remote.{name}.url"))
            .await?
            .map(|_| (*name).clone()));
    };
    let exact: Vec<&String> = remote_refs
        .iter()
        .filter(|(_, o)| *o == local)
        .map(|(n, _)| *n)
        .collect();
    if exact.len() > 1 {
        return Ok(None);
    }
    let remote = match exact.first() {
        Some(name) => (*name).clone(),
        None => {
            let mut ancestors = Vec::new();
            for (name, oid) in &remote_refs {
                let output = git(
                    "GitManager.findPublishedBranchRemote.ancestor",
                    cwd,
                    ["merge-base", "--is-ancestor", oid, local],
                )
                .allow_exit(&[0, 1])
                .timeout(PROBE_TIMEOUT)
                .run()
                .await
                .map_err(crate::error::VcsError::from)?;
                if output.code == 0 {
                    ancestors.push((*name).clone());
                }
            }
            if ancestors.len() != 1 {
                return Ok(None);
            }
            ancestors.remove(0)
        }
    };
    Ok(config_get(cwd, &format!("remote.{remote}.url"))
        .await?
        .map(|_| remote))
}

/// `origin` when it exists, else the first remote.
pub async fn primary_remote(cwd: &Path) -> VcsResult<Option<String>> {
    let names = remote_names(cwd).await?;
    if names.iter().any(|n| n == "origin") {
        return Ok(Some("origin".into()));
    }
    Ok(names.into_iter().next())
}

/// The default branch of `remote` from `refs/remotes/<remote>/HEAD`, without the prefix.
pub async fn remote_default_branch(cwd: &Path, remote: &str) -> VcsResult<Option<String>> {
    let head = optional_text(git(
        "GitVcsDriver.remoteDefaultBranch",
        cwd,
        [
            "symbolic-ref".to_owned(),
            format!("refs/remotes/{remote}/HEAD"),
        ],
    ))
    .await?;
    let prefix = format!("refs/remotes/{remote}/");
    Ok(head.and_then(|h| h.strip_prefix(&prefix).map(str::to_owned)))
}

/// The remote names, the primary remote and its default branch: what the default-branch and
/// base lookups read. One status refresh reads them once and passes them on.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Remotes {
    pub names: Vec<String>,
    /// `origin` when it exists, else the first remote.
    pub primary: Option<String>,
    /// `refs/remotes/<primary>/HEAD`, without the prefix.
    pub primary_default: Option<String>,
}

impl Remotes {
    /// `git remote`, then `symbolic-ref` for the primary remote's HEAD when there is one: the
    /// same calls [`primary_remote`] and [`remote_default_branch`] make.
    pub async fn load(cwd: &Path) -> VcsResult<Self> {
        let names = remote_names(cwd).await?;
        let primary = if names.iter().any(|n| n == "origin") {
            Some("origin".to_owned())
        } else {
            names.first().cloned()
        };
        let primary_default = match primary.as_deref() {
            Some(remote) => remote_default_branch(cwd, remote).await?,
            None => None,
        };
        Ok(Self {
            names,
            primary,
            primary_default,
        })
    }
}

/// The repository's default branch name: the primary remote's HEAD, else a local `main` or
/// `master`.
pub async fn default_branch(cwd: &Path) -> VcsResult<Option<String>> {
    // Boxed: the nested git calls make a large future.
    Box::pin(async {
        let remotes = Remotes::load(cwd).await?;
        default_branch_with(cwd, &remotes).await
    })
    .await
}

/// [`default_branch`] with the remotes already read.
pub async fn default_branch_with(cwd: &Path, remotes: &Remotes) -> VcsResult<Option<String>> {
    if let Some(branch) = &remotes.primary_default {
        return Ok(Some(branch.clone()));
    }
    for name in ["main", "master"] {
        if ref_exists(cwd, &format!("refs/heads/{name}")).await? {
            return Ok(Some(name.into()));
        }
    }
    Ok(None)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BaseRef {
    /// What clients show, such as `origin/main` or `main`.
    pub base_ref: String,
    /// The full ref git compares against.
    pub comparison_ref: String,
}

fn comparison_candidate(base: &str) -> Option<String> {
    if base.starts_with("refs/heads/") || base.starts_with("refs/remotes/") {
        Some(base.to_owned())
    } else if base.contains('/') && !base.starts_with("refs/") {
        Some(format!("refs/remotes/{base}"))
    } else {
        None
    }
}

async fn resolve_comparison(cwd: &Path, base: &str) -> VcsResult<BaseRef> {
    if let Some(candidate) = comparison_candidate(base)
        && ref_exists(cwd, &candidate).await?
    {
        return Ok(BaseRef {
            base_ref: base.to_owned(),
            comparison_ref: candidate,
        });
    }
    let comparison_ref =
        if !base.starts_with("refs/") && ref_exists(cwd, &format!("refs/heads/{base}")).await? {
            format!("refs/heads/{base}")
        } else {
            base.to_owned()
        };
    Ok(BaseRef {
        base_ref: base.to_owned(),
        comparison_ref,
    })
}

/// The base a branch compares against: an explicit base; else the branch's recorded base
/// (`branch.<b>.t3-merge-base-ref`, `t3-merge-base`, `gh-merge-base`); else the primary
/// remote's default branch, `main` or `master`, preferring the remote-tracking ref.
pub async fn resolve_base(
    cwd: &Path,
    branch: Option<&str>,
    explicit: Option<&str>,
) -> VcsResult<Option<BaseRef>> {
    resolve_base_with(cwd, branch, explicit, None).await
}

/// [`resolve_base`] with the remotes already read, or `None` to read them when needed.
pub async fn resolve_base_with(
    cwd: &Path,
    branch: Option<&str>,
    explicit: Option<&str>,
    remotes: Option<&Remotes>,
) -> VcsResult<Option<BaseRef>> {
    // Boxed: the nested git calls make a large future.
    Box::pin(resolve_base_inner(cwd, branch, explicit, remotes)).await
}

async fn resolve_base_inner(
    cwd: &Path,
    branch: Option<&str>,
    explicit: Option<&str>,
    remotes: Option<&Remotes>,
) -> VcsResult<Option<BaseRef>> {
    if let Some(base) = explicit {
        return resolve_comparison(cwd, base).await.map(Some);
    }
    let Some(branch) = branch else {
        return Ok(None);
    };
    if let Some(full) = config_get(cwd, &format!("branch.{branch}.t3-merge-base-ref")).await?
        && (full.starts_with("refs/heads/") || full.starts_with("refs/remotes/"))
        && ref_exists(cwd, &full).await?
    {
        let stripped = full
            .strip_prefix("refs/heads/")
            .or_else(|| full.strip_prefix("refs/remotes/"))
            .unwrap_or(&full);
        let base_ref = if ref_exists(cwd, &format!("refs/heads/{stripped}")).await? {
            full.clone()
        } else {
            full.trim_start_matches("refs/remotes/").to_owned()
        };
        return Ok(Some(BaseRef {
            base_ref,
            comparison_ref: full,
        }));
    }
    let configured = match config_get(cwd, &format!("branch.{branch}.t3-merge-base")).await? {
        Some(v) => Some(v),
        None => config_get(cwd, &format!("branch.{branch}.gh-merge-base")).await?,
    };
    if let Some(configured) = configured.as_deref()
        && let Some(candidate) = comparison_candidate(configured)
        && ref_exists(cwd, &candidate).await?
    {
        if configured.contains('/')
            && !configured.starts_with("refs/")
            && ref_exists(cwd, &format!("refs/heads/{configured}")).await?
        {
            let local = format!("refs/heads/{configured}");
            return Ok(Some(BaseRef {
                base_ref: local.clone(),
                comparison_ref: local,
            }));
        }
        return Ok(Some(BaseRef {
            base_ref: configured.to_owned(),
            comparison_ref: candidate,
        }));
    }

    let loaded;
    let remotes = match remotes {
        Some(remotes) => remotes,
        None => {
            loaded = Remotes::load(cwd).await?;
            &loaded
        }
    };
    let primary = remotes.primary.clone();
    let remote_default = remotes.primary_default.clone();
    let candidates = [
        configured,
        remote_default,
        Some("main".to_owned()),
        Some("master".to_owned()),
    ];
    for candidate in candidates.into_iter().flatten() {
        if candidate.is_empty() {
            continue;
        }
        let name = match primary.as_deref() {
            Some(remote) => candidate
                .strip_prefix(&format!("{remote}/"))
                .map(str::to_owned)
                .unwrap_or(candidate),
            None => candidate,
        };
        let name = name
            .strip_prefix("origin/")
            .map(str::to_owned)
            .unwrap_or(name);
        if name == branch {
            if let Some(upstream) = optional_text(git(
                "GitVcsDriver.upstreamRef",
                cwd,
                [
                    "rev-parse".to_owned(),
                    "--symbolic-full-name".into(),
                    format!("{branch}@{{upstream}}"),
                ],
            ))
            .await?
                && let Some(short) = upstream.strip_prefix("refs/remotes/")
            {
                return Ok(Some(BaseRef {
                    base_ref: short.to_owned(),
                    comparison_ref: upstream.clone(),
                }));
            }
            if let Some(remote) = primary.as_deref() {
                let full = format!("refs/remotes/{remote}/{name}");
                if ref_exists(cwd, &full).await? {
                    return Ok(Some(BaseRef {
                        base_ref: format!("{remote}/{name}"),
                        comparison_ref: full,
                    }));
                }
            }
            continue;
        }
        if let Some(remote) = primary.as_deref() {
            let full = format!("refs/remotes/{remote}/{name}");
            if ref_exists(cwd, &full).await? {
                return Ok(Some(BaseRef {
                    base_ref: format!("{remote}/{name}"),
                    comparison_ref: full,
                }));
            }
        }
        if ref_exists(cwd, &format!("refs/heads/{name}")).await? {
            return Ok(Some(BaseRef {
                comparison_ref: format!("refs/heads/{name}"),
                base_ref: name,
            }));
        }
    }
    Ok(None)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MergeBase {
    pub base_ref: Option<String>,
    /// A commit sha, or `HEAD` when there is no base.
    pub merge_base: String,
}

/// The merge base of HEAD and the branch's base. `HEAD` when no base resolves.
pub async fn merge_base(
    cwd: &Path,
    branch: Option<&str>,
    explicit: Option<&str>,
) -> VcsResult<MergeBase> {
    merge_base_with(cwd, branch, explicit, None).await
}

/// [`merge_base`] with the remotes already read, or `None` to read them when needed.
pub async fn merge_base_with(
    cwd: &Path,
    branch: Option<&str>,
    explicit: Option<&str>,
    remotes: Option<&Remotes>,
) -> VcsResult<MergeBase> {
    // Boxed: the nested git calls make a large future.
    Box::pin(merge_base_inner(cwd, branch, explicit, remotes)).await
}

async fn merge_base_inner(
    cwd: &Path,
    branch: Option<&str>,
    explicit: Option<&str>,
    remotes: Option<&Remotes>,
) -> VcsResult<MergeBase> {
    let Some(base) = resolve_base_with(cwd, branch, explicit, remotes)
        .await
        .unwrap_or(None)
    else {
        return Ok(MergeBase {
            base_ref: None,
            merge_base: "HEAD".into(),
        });
    };
    let found = optional_text(git(
        "GitVcsDriver.resolveReviewMergeBase",
        cwd,
        [
            "merge-base",
            "--end-of-options",
            base.comparison_ref.as_str(),
            "HEAD",
        ],
    ))
    .await?
    .filter(|sha| !sha.is_empty());
    match found {
        Some(sha) => Ok(MergeBase {
            base_ref: Some(base.base_ref),
            merge_base: sha,
        }),
        None if explicit.is_none() && !has_head_commit(cwd).await? => Ok(MergeBase {
            base_ref: None,
            merge_base: "HEAD".into(),
        }),
        None => Err(VcsError::invalid(
            "GitVcsDriver.resolveReviewMergeBase",
            &cwd.to_string_lossy(),
            format!(
                "Could not find a common commit between '{}' and HEAD.",
                base.base_ref
            ),
        )),
    }
}

/// The hash of the empty tree in this repository's object format.
pub async fn empty_tree(cwd: &Path) -> VcsResult<String> {
    Ok(git(
        "GitVcsDriver.readEmptyTreeHash",
        cwd,
        ["hash-object", "-t", "tree", "/dev/null"],
    )
    .text()
    .await?
    .trim()
    .to_owned())
}
