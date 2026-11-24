//! Worktrees: create from a ref, list, remove. Used by `vcs.createWorktree` /
//! `vcs.removeWorktree` and by thread launch with a worktree strategy (see [`crate::setup`]).
//!
//! Paths follow `GitVcsDriverCore.createWorktree`: `<worktrees dir>/<repo>/<branch>-<hash16>`,
//! where the hash is `sha256(<git common dir> NUL <branch>)`.

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::{
    error::{VcsError, VcsResult},
    process::{GitCommand, OnLimit, ProcessError},
    refs::parse_worktree_branches,
    repo::{self, git},
};

const OPERATION: &str = "GitVcsDriver.createWorktree";
/// Branch name prefix kept in a worktree folder name, in UTF-8 bytes.
const PREFIX_MAX_BYTES: usize = 23;
pub const REMOVE_TIMEOUT: Duration = Duration::from_secs(300);
/// `git ls-files --stage` output read for gitlinks, about 400,000 entries. A larger index
/// fails safe removal, and deletes nothing.
const INDEX_MAX_BYTES: usize = 32 << 20;

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
/// the checkout fails. A caller that drops this future mid-checkout (an RPC whose client left)
/// loses nothing to a lock: a background task removes the checkout and its new branch, as the
/// TypeScript server does on an interrupt.
pub async fn create_worktree(input: &CreateWorktree) -> VcsResult<Worktree> {
    let mut pending = DiscardOnDrop {
        cwd: input.cwd.clone(),
        branch: input.new_ref_name.clone(),
        claim: None,
    };
    let result = create_worktree_claiming(input, &mut pending.claim).await;
    pending.claim = None;
    result
}

/// Discards a claimed checkout when its [`create_worktree`] future is dropped before it ends.
struct DiscardOnDrop {
    cwd: PathBuf,
    branch: Option<String>,
    claim: Option<Claim>,
}

impl Drop for DiscardOnDrop {
    fn drop(&mut self) {
        let (Some(claim), Some(branch)) = (self.claim.take(), self.branch.take()) else {
            return;
        };
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let cwd = std::mem::take(&mut self.cwd);
        runtime.spawn(async move {
            let _ = discard_claim(&cwd, &claim, &branch).await;
        });
    }
}

/// A checkout [`create_worktree_claiming`] started: its path, and the lock reason Git holds on
/// its registration until the checkout ends (`None` when this Git cannot set one).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Claim {
    pub path: PathBuf,
    pub lock_reason: Option<String>,
}

/// [`create_worktree`], reporting the checkout in `claimed` once its new branch exists and
/// before `git worktree add` runs. A caller that stops this future during the checkout then
/// knows what to remove with [`discard_claim`].
pub async fn create_worktree_claiming(
    input: &CreateWorktree,
    claimed: &mut Option<Claim>,
) -> VcsResult<Worktree> {
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
    // Read before the branch exists, so a missing pattern file leaves nothing behind.
    let sparse = sparse_patterns(cwd, &start, &input.ref_name).await?;

    // Git writes the lock during registration, before the checkout or any hook runs, so a
    // checkout killed midway still carries a reason that proves it is ours.
    let lock_reason = match &input.new_ref_name {
        Some(_) => supports_lock_reason(cwd)
            .await
            .then(|| format!("t3-create-{}", conn_support::uuid_v4())),
        None => None,
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

    if input.new_ref_name.is_some() {
        *claimed = Some(Claim {
            path: path.clone(),
            lock_reason: lock_reason.clone(),
        });
    }
    let workers = repo::config_get(cwd, "checkout.workers")
        .await
        .unwrap_or(None)
        .unwrap_or_else(|| "0".into());
    let mut add = vec![
        "-c".to_owned(),
        format!("checkout.workers={workers}"),
        "worktree".into(),
        "add".into(),
    ];
    if let Some(reason) = &lock_reason {
        add.extend(["--lock".to_owned(), "--reason".into(), reason.clone()]);
    }
    if sparse.is_some() {
        add.push("--no-checkout".into());
    }
    add.extend([
        "--".into(),
        path.to_string_lossy().into_owned(),
        target.clone(),
    ]);
    let mut added = git(OPERATION, cwd, add)
        .timeout(Duration::from_secs(3600))
        .max_stdout(1_000_000, OnLimit::Truncate)
        .run()
        .await
        .map(drop)
        .map_err(VcsError::from);
    let mut sparse_failed = false;
    if added.is_ok()
        && let Some(patterns) = sparse
    {
        added = sparse_checkout(&path, &workers, patterns).await;
        sparse_failed = added.is_err();
    }
    // The lock covers the files' checkout, sparse or not; a locked worktree needs a double
    // force to remove.
    if let Some(reason) = &lock_reason {
        let _ = unlock_registration(cwd, reason).await;
    }
    if sparse_failed {
        // A worktree without its files is no use.
        let _ = remove_worktree(cwd, &path, Removal::Force).await;
    }
    if let Err(error) = added {
        if let Some(new) = &input.new_ref_name {
            let _ = git(OPERATION, cwd, ["branch", "-D", "--", new.as_str()])
                .run()
                .await;
        }
        return Err(error);
    }

    if let (Some(new), Some(base)) = (&input.new_ref_name, &input.base_ref_name) {
        record_base(cwd, new, base).await;
    }
    Ok(Worktree {
        path,
        ref_name: Some(target),
    })
}

/// `t3.json` at `rev` as `parseT3ProjectFile` reads it: lenient JSON that decodes as a whole,
/// else `None` (T3 then checks out every file and initializes submodules recursively).
async fn project_file(cwd: &Path, rev: &str) -> Option<ProjectFile> {
    let spec = format!("{rev}:t3.json");
    let text = repo::optional_text(git(OPERATION, cwd, ["show", spec.as_str()]))
        .await
        .ok()??;
    // Through `Value`, so a repeated key takes its last value, as `JSON.parse` does.
    let value: serde_json::Value = conn_support::json::parse_lenient(&text)?;
    ProjectFile::deserialize(value).ok()
}

/// `T3ProjectFile`. Fields Conn does not use are decoded only so an invalid one rejects the
/// file, as in T3; unknown keys are ignored.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[expect(dead_code, reason = "decoded only to validate the file")]
struct ProjectFile {
    #[serde(rename = "$schema", default, deserialize_with = "present")]
    schema: Option<String>,
    #[serde(default, deserialize_with = "present")]
    icon_path: Option<Trimmed<PATH_MAX>>,
    #[serde(default, deserialize_with = "present")]
    default_thread_env_mode: Option<conn_contract::ThreadEnvMode>,
    #[serde(default, deserialize_with = "present")]
    worktree_submodules: Option<Submodules>,
    #[serde(default, deserialize_with = "present")]
    worktree_sparse_patterns_path: Option<Trimmed<PATH_MAX>>,
    #[serde(default, deserialize_with = "scripts")]
    scripts: Option<Vec<ProjectFileScript>>,
}

/// `T3ProjectFileScript`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[expect(dead_code, reason = "decoded only to validate the file")]
struct ProjectFileScript {
    name: Trimmed<{ usize::MAX }>,
    command: Trimmed<{ usize::MAX }>,
    #[serde(default, deserialize_with = "present")]
    icon: Option<conn_contract::ProjectScriptIcon>,
    #[serde(default, deserialize_with = "present")]
    run_on_worktree_create: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    run_on_settle: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    stop_on_settle: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    r#async: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    preview_url: Option<Trimmed<{ usize::MAX }>>,
    #[serde(default, deserialize_with = "present")]
    auto_open_preview: Option<bool>,
}

const PATH_MAX: usize = 512;

/// `trimmedNonEmpty`: at most `MAX` UTF-16 units before trimming, not empty after.
struct Trimmed<const MAX: usize>(String);

impl<'de, const MAX: usize> Deserialize<'de> for Trimmed<MAX> {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(d)?;
        let trimmed = conn_support::text::js_trim(&raw);
        if trimmed.is_empty() || raw.encode_utf16().count() > MAX {
            return Err(serde::de::Error::custom(
                "expected a trimmed non-empty string",
            ));
        }
        Ok(Self(trimmed.to_owned()))
    }
}

/// `Schema.optionalKey`: the key may be missing, but `null` is not a value.
fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

fn scripts<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Vec<ProjectFileScript>>, D::Error> {
    let scripts = Vec::deserialize(d)?;
    if scripts.len() > 50 {
        return Err(serde::de::Error::custom("at most 50 scripts"));
    }
    Ok(Some(scripts))
}

/// `readWorktreeSparsePatterns`: the non-cone patterns named by `t3.json`'s
/// `worktreeSparsePatternsPath` at `rev`, or `None` for a full checkout. A named file that
/// is not in `rev` fails the worktree, so it never checks out everything by mistake.
async fn sparse_patterns(cwd: &Path, rev: &str, ref_name: &str) -> VcsResult<Option<Vec<u8>>> {
    let Some(Trimmed(named)) = project_file(cwd, rev)
        .await
        .and_then(|file| file.worktree_sparse_patterns_path)
    else {
        return Ok(None);
    };
    // Git reads `<rev>:./path` from the working folder, so keep it repository-relative.
    let relative = named.trim_start_matches("./");
    let read = if relative.split('/').any(|part| part == "..") {
        None
    } else {
        let spec = format!("{rev}:{relative}");
        match git(OPERATION, cwd, ["cat-file", "blob", spec.as_str()])
            .run()
            .await
        {
            Ok(out) => Some(out.stdout),
            Err(ProcessError::Exit { .. }) => None,
            Err(e) => return Err(e.into()),
        }
    };
    read.map(Some).ok_or_else(|| {
        invalid(
            cwd,
            format!(
                "t3.json names the sparse-checkout pattern file \"{named}\", which is not a file in {ref_name}."
            ),
        )
    })
}

/// Limits a `--no-checkout` worktree to `patterns`, then checks it out.
async fn sparse_checkout(path: &Path, workers: &str, patterns: Vec<u8>) -> VcsResult<()> {
    git(
        OPERATION,
        path,
        ["sparse-checkout", "set", "--no-cone", "--stdin"],
    )
    .stdin(patterns)
    .run()
    .await?;
    git(
        OPERATION,
        path,
        [
            "-c".to_owned(),
            format!("checkout.workers={workers}"),
            "checkout".into(),
        ],
    )
    .timeout(Duration::from_secs(3600))
    .max_stdout(1_000_000, OnLimit::Truncate)
    .run()
    .await?;
    Ok(())
}

/// `worktreeSubmodules`: how a new worktree fills its submodules.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Submodules {
    None,
    TopLevel,
    Recursive,
}

/// Where a [`Submodules`] value came from, as setup reports a disabled one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    /// The settings, or the default when neither names one.
    Settings,
    ProjectFile,
}

impl Origin {
    pub fn label(self) -> &'static str {
        match self {
            Origin::Settings => "settings",
            Origin::ProjectFile => "t3.json",
        }
    }
}

impl Submodules {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "none" => Some(Self::None),
            "top-level" => Some(Self::TopLevel),
            "recursive" => Some(Self::Recursive),
            _ => None,
        }
    }
}

/// `resolveProjectFileBackedSetting("worktreeSubmodules", …)` for a new worktree: the setting
/// (`None` inherits), else `t3.json` at `HEAD`, else recursive. `None` when `HEAD` has no
/// `.gitmodules`. Both files are read from `HEAD`: sparse patterns can leave them out.
pub async fn submodule_mode(
    worktree: &Path,
    setting: Option<&str>,
) -> Option<(Submodules, Origin)> {
    let listed = repo::succeeds(git(
        "GitVcsDriver.createWorktree.findSubmodules",
        worktree,
        ["cat-file", "-e", "HEAD:.gitmodules"],
    ))
    .await
    .unwrap_or(false);
    if !listed {
        return None;
    }
    if let Some(mode) = setting.and_then(Submodules::parse) {
        return Some((mode, Origin::Settings));
    }
    let from_file = project_file(worktree, "HEAD")
        .await
        .and_then(|file| file.worktree_submodules);
    Some(match from_file {
        Some(mode) => (mode, Origin::ProjectFile),
        None => (Submodules::Recursive, Origin::Settings),
    })
}

/// [`submodule_mode`], then [`update_submodules`]: what a new worktree outside thread setup
/// does with its submodules. A failure is logged and the worktree kept, as in T3.
pub async fn populate_submodules(worktree: &Path, setting: Option<&str>) {
    if let Some((mode, _)) = submodule_mode(worktree, setting).await
        && let Err(error) = update_submodules(worktree, mode).await
    {
        eprintln!(
            "conn-vcs: worktree submodule checkout failed; submodules may be incomplete: {error}"
        );
    }
}

/// Initializes and checks out a new worktree's submodules. A failure leaves the worktree, as
/// T3 does: the caller reports it, and the submodules that did clone are checked out anyway.
pub async fn update_submodules(worktree: &Path, mode: Submodules) -> VcsResult<()> {
    let update = |paths: Vec<String>| async move {
        let mut args = vec!["submodule".to_owned(), "update".into(), "--init".into()];
        if mode == Submodules::Recursive {
            args.push("--recursive".into());
        }
        if !paths.is_empty() {
            args.extend(["--force".into(), "--".into()]);
            args.extend(paths);
        }
        git(
            "GitVcsDriver.createWorktree.updateSubmodules",
            worktree,
            args,
        )
        .timeout(Duration::from_secs(3600))
        .max_stdout(1_000_000, OnLimit::Truncate)
        .run()
        .await
        .map(drop)
        .map_err(VcsError::from)
    };
    if mode == Submodules::None {
        return Ok(());
    }
    let result = match git(
        "GitVcsDriver.createWorktree.initSubmodules",
        worktree,
        ["submodule", "init"],
    )
    .run()
    .await
    {
        Ok(_) => update(Vec::new()).await,
        Err(e) => Err(e.into()),
    };
    if result.is_err() {
        // One failed clone stops git before any checkout: check out the ones that cloned.
        let listed = repo::optional_text(git(
            "GitVcsDriver.createWorktree.listSubmodules",
            worktree,
            [
                "config",
                "-z",
                "--blob",
                "HEAD:.gitmodules",
                "--get-regexp",
                r"^submodule\..*\.path$",
            ],
        ))
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
        // Records are `submodule.<name>.path\n<path>`.
        let paths: Vec<PathBuf> = listed
            .split('\0')
            .filter_map(|record| record.split_once('\n').map(|(_, path)| PathBuf::from(path)))
            .collect();
        let root = worktree.to_owned();
        let cloned: Vec<String> = tokio::task::spawn_blocking(move || {
            paths
                .into_iter()
                .filter(|path| root.join(path).join(".git").exists())
                .map(|path| path.to_string_lossy().into_owned())
                .collect()
        })
        .await
        .unwrap_or_default();
        if !cloned.is_empty() {
            let _ = update(cloned).await;
        }
    }
    result
}

/// Entries `git worktree remove` can leave behind without a checkout
/// (`LEFTOVER_WORKTREE_ENTRIES`).
const LEFTOVER_ENTRIES: [&str; 2] = ["node_modules", ".next"];

/// `restoreMissingWorktree` (T3 `workspace/restoreMissingWorktree.ts`): checks `branch` out
/// again at `path` when the folder is gone or holds only leftover dependency folders, which
/// are cleared first. Returns whether it recreated the checkout. The caller decides that
/// `path` is a managed worktree of `project_root`.
pub async fn restore_missing_worktree(
    project_root: &Path,
    path: &Path,
    branch: &str,
) -> VcsResult<bool> {
    let folder = path.to_owned();
    let missing = tokio::task::spawn_blocking(move || clear_leftover_folder(&folder))
        .await
        .map_err(|e| invalid(project_root, e.to_string()))?
        .map_err(|e| invalid(project_root, e.to_string()))?;
    if !missing {
        return Ok(false);
    }
    recreate_worktree(project_root, path, branch).await?;
    Ok(true)
}

/// Whether `path` needs a checkout, by T3's rule in `restoreMissingWorktree`: it does not
/// exist, or it holds no `.git` and only leftover folders. A folder that cannot be read counts
/// as present, as T3's `exists` does on an error. Off the runtime thread.
pub async fn needs_checkout(path: &Path) -> bool {
    let folder = path.to_owned();
    tokio::task::spawn_blocking(move || leftover_entries(&folder).is_some())
        .await
        .unwrap_or(false)
}

/// The entries to clear before a checkout at `path`: `Some(vec![])` when it does not exist,
/// `None` when it is a checkout or holds anything but leftovers.
fn leftover_entries(path: &Path) -> Option<Vec<std::fs::DirEntry>> {
    let entries = match std::fs::read_dir(path) {
        Ok(entries) => entries.collect::<Result<Vec<_>, _>>().ok()?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Some(Vec::new()),
        Err(_) => return None,
    };
    let leftover = entries.iter().all(|entry| {
        let name = entry.file_name();
        LEFTOVER_ENTRIES.iter().any(|l| name == *l) && entry.file_type().is_ok_and(|t| t.is_dir())
    });
    (leftover && !path.join(".git").exists()).then_some(entries)
}

/// Whether `path` needs a checkout; leftovers are removed. The folder itself stays: it may be
/// a running process's working folder.
fn clear_leftover_folder(path: &Path) -> std::io::Result<bool> {
    let Some(entries) = leftover_entries(path) else {
        return Ok(false);
    };
    for entry in entries {
        std::fs::remove_dir_all(entry.path())?;
    }
    Ok(true)
}

/// Removes the stale registration of `path` alone, as `git worktree prune` would remove it:
/// its `gitdir` names `<path>/.git`, which is gone, and it is not locked. A repository-wide
/// prune would also drop worktrees whose folders are only away, such as on an unmounted drive.
fn forget_stale_registration(common_dir: &Path, path: &Path) -> std::io::Result<()> {
    let target = real_location(&path.join(".git"));
    if target.exists() {
        return Ok(());
    }
    let entries = match std::fs::read_dir(common_dir.join("worktrees")) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    for entry in entries {
        let admin = entry?.path();
        let Ok(gitdir) = std::fs::read_to_string(admin.join("gitdir")) else {
            continue;
        };
        let registered = Path::new(gitdir.trim());
        if registered.is_absolute()
            && real_location(registered) == target
            && !admin.join("locked").exists()
        {
            std::fs::remove_dir_all(&admin)?;
        }
    }
    Ok(())
}

/// The nearest existing ancestor's real path, plus the missing components: two spellings of a
/// missing path (`/var` and `/private/var` on macOS) compare equal.
fn real_location(path: &Path) -> PathBuf {
    let mut missing = Vec::new();
    let mut current = path;
    loop {
        if let Ok(real) = std::fs::canonicalize(current) {
            return missing.iter().rev().fold(real, |acc, part| acc.join(part));
        }
        match (current.parent(), current.file_name()) {
            (Some(parent), Some(name)) => {
                missing.push(name.to_owned());
                current = parent;
            }
            _ => return path.to_owned(),
        }
    }
}

/// `restoreMissingWorktree.recreate`: the local branch when it survives; else its pushed copy
/// (`refs/remotes/<remote>/<branch>`), read without a fetch; else a new branch from the
/// project's current branch, the remote's default commit, or `HEAD`.
async fn recreate_worktree(project_root: &Path, path: &Path, branch: &str) -> VcsResult<()> {
    refuse_option_like(project_root, branch)?;
    let common = common_dir(project_root).await?;
    let stale = path.to_owned();
    tokio::task::spawn_blocking(move || forget_stale_registration(&common, &stale))
        .await
        .map_err(|e| invalid(project_root, e.to_string()))?
        .map_err(|e| invalid(project_root, e.to_string()))?;
    let target = path.to_string_lossy().into_owned();
    let add = |args: Vec<String>| async move {
        let mut full = vec!["worktree".to_owned(), "add".to_owned()];
        full.extend(args);
        git(OPERATION, project_root, full)
            .timeout(Duration::from_secs(3600))
            .max_stdout(1_000_000, OnLimit::Truncate)
            .run()
            .await
            .map(drop)
            .map_err(VcsError::from)
    };
    if repo::ref_exists(project_root, &format!("refs/heads/{branch}")).await? {
        return add(vec!["--".into(), target, branch.to_owned()]).await;
    }
    let remote = repo::primary_remote(project_root).await.ok().flatten();
    if let Some(remote) = &remote {
        let pushed = format!("refs/remotes/{remote}/{branch}");
        if repo::ref_exists(project_root, &pushed).await? {
            return add(vec![
                "-b".into(),
                branch.to_owned(),
                "--".into(),
                target,
                pushed,
            ])
            .await;
        }
    }
    let (start, base) = match repo::current_branch(project_root).await? {
        Some(current) => {
            let full = format!("refs/heads/{current}");
            (full.clone(), Some(full))
        }
        None => match remote {
            Some(remote)
                if repo::ref_exists(project_root, &format!("refs/remotes/{remote}/HEAD"))
                    .await? =>
            {
                let head = format!("refs/remotes/{remote}/HEAD");
                // The commit, so the new branch does not track the default branch.
                let commit = repo::resolve_commit(project_root, &head)
                    .await?
                    .ok_or_else(|| {
                        invalid(project_root, "the remote default branch has no commit")
                    })?;
                (commit, Some(head))
            }
            _ if repo::has_head_commit(project_root).await? => ("HEAD".to_owned(), None),
            _ => {
                return Err(invalid(
                    project_root,
                    format!(
                        "Could not recreate branch '{branch}' at {}: the project workspace has no commit to start it from.",
                        path.display()
                    ),
                ));
            }
        },
    };
    git(
        OPERATION,
        project_root,
        ["branch", "--no-track", "--", branch, start.as_str()],
    )
    .run()
    .await?;
    add(vec!["--".into(), target, branch.to_owned()]).await?;
    if let Some(base) = base {
        record_base(project_root, branch, &base).await;
    }
    Ok(())
}

/// Records `base` as the new branch's base (`branch.<new>.t3-merge-base`), for Changes totals.
async fn record_base(cwd: &Path, new: &str, base: &str) {
    let Some((branch_name, full)) = resolve_branch_base(cwd, base).await else {
        return;
    };
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
    if let Some(annexed) = Annexed::find(cwd, &target).await? {
        return annexed.remove(cwd, &target, removal).await;
    }
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
    blocking(path, move || target.exists()).await
}

async fn blocking<T: Send + 'static>(
    cwd: &Path,
    work: impl FnOnce() -> T + Send + 'static,
) -> VcsResult<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| invalid(cwd, e.to_string()))
}

/// A refusal worded as `git worktree remove` words it.
fn refuse(worktree: &Path, detail: impl std::fmt::Display) -> VcsError {
    VcsError::invalid(
        "GitVcsDriver.removeWorktree",
        &worktree.to_string_lossy(),
        format!("fatal: {detail}"),
    )
}

/// A linked worktree whose `.git` file git-annex replaced with a symlink to its admin folder.
/// `git worktree remove` refuses that layout, so this removes it the way git removes a
/// worktree: the same checks, then the checkout, then the admin folder. `.git` is never
/// rewritten.
struct Annexed {
    /// The checkout, resolved.
    checkout: PathBuf,
    /// `<common dir>/worktrees/<name>`, resolved.
    admin: PathBuf,
}

impl Annexed {
    /// `None` when `.git` is not a symlink: that layout is git's to handle. A symlink that does
    /// not resolve to this repository's admin folder for this checkout is refused here, before
    /// anything changes.
    async fn find(cwd: &Path, worktree: &Path) -> VcsResult<Option<Self>> {
        let dot_git = worktree.join(".git");
        let linked = blocking(cwd, {
            let dot_git = dot_git.clone();
            move || std::fs::symlink_metadata(dot_git).is_ok_and(|m| m.is_symlink())
        })
        .await?;
        if !linked {
            return Ok(None);
        }
        let common = common_dir(cwd).await?;
        let worktree = worktree.to_owned();
        blocking(cwd, move || {
            registered_admin(&worktree, &dot_git, &common)
                .zip(std::fs::canonicalize(&worktree).ok())
                .map(|(admin, checkout)| Some(Self { checkout, admin }))
                .ok_or_else(|| {
                    refuse(
                        &worktree,
                        format_args!("'{}' is not a working tree", worktree.display()),
                    )
                })
        })
        .await?
    }

    /// `git worktree remove`: a locked worktree is refused; without force, so is one with
    /// submodules or with modified or untracked files.
    async fn remove(self, cwd: &Path, worktree: &Path, removal: Removal) -> VcsResult<()> {
        let admin = self.admin.clone();
        let (locked, modules) = blocking(cwd, move || {
            let locked = admin.join("locked");
            let locked = locked.exists().then(|| {
                std::fs::read_to_string(locked)
                    .map(|reason| reason.trim().to_owned())
                    .unwrap_or_default()
            });
            (locked, admin.join("modules").is_dir())
        })
        .await?;
        match locked.as_deref() {
            Some("") => {
                return Err(refuse(
                    worktree,
                    "cannot remove a locked working tree;\nuse 'remove -f -f' to override or unlock first",
                ));
            }
            Some(reason) => {
                return Err(refuse(
                    worktree,
                    format_args!(
                        "cannot remove a locked working tree, lock reason: {reason}\nuse 'remove -f -f' to override or unlock first"
                    ),
                ));
            }
            None => {}
        }
        if removal == Removal::Safe {
            if modules || self.has_populated_submodule(cwd).await? {
                return Err(refuse(
                    worktree,
                    "working trees containing submodules cannot be moved or removed",
                ));
            }
            // One byte answers the question.
            let status = self
                .git([
                    "status",
                    "--porcelain",
                    "--ignore-submodules=none",
                    "--untracked-files=all",
                ])
                .max_stdout(1, OnLimit::Truncate)
                .run()
                .await?;
            if !status.stdout.is_empty() {
                return Err(refuse(
                    worktree,
                    format_args!(
                        "'{}' contains modified or untracked files, use --force to delete it",
                        worktree.display()
                    ),
                ));
            }
        }
        let worktree_for_error = worktree.to_owned();
        blocking(cwd, move || self.delete())
            .await?
            .map_err(|e| refuse(&worktree_for_error, e))
    }

    /// `git` on this worktree as `git worktree remove` runs it: `GIT_DIR` and `GIT_WORK_TREE`
    /// set, so a `core.worktree` in its `config.worktree` cannot send it to another checkout.
    fn git<const N: usize>(&self, args: [&str; N]) -> GitCommand {
        git("GitVcsDriver.removeWorktree", &self.checkout, args)
            .env("GIT_DIR", &self.admin)
            .env("GIT_WORK_TREE", &self.checkout)
            .timeout(REMOVE_TIMEOUT)
    }

    /// `validate_no_submodules`: an index entry of mode `160000` whose checkout has a `.git`
    /// that resolves to a git directory. An unpopulated one does not count.
    async fn has_populated_submodule(&self, cwd: &Path) -> VcsResult<bool> {
        let index = self
            .git(["ls-files", "--stage", "-z"])
            .max_stdout(INDEX_MAX_BYTES, OnLimit::Fail)
            .run()
            .await?
            .stdout;
        let dot_gits: Vec<PathBuf> = {
            use std::os::unix::ffi::OsStrExt as _;
            index
                .split(|b| *b == 0)
                .filter_map(|entry| {
                    let tab = entry.iter().position(|b| *b == b'\t')?;
                    let (meta, name) = (entry.get(..tab)?, entry.get(tab + 1..)?);
                    meta.starts_with(b"160000 ").then(|| {
                        self.checkout
                            .join(std::ffi::OsStr::from_bytes(name))
                            .join(".git")
                    })
                })
                .collect()
        };
        for dot_git in dot_gits {
            if resolves_to_git_dir(cwd, &dot_git).await? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Deletes the checkout, then the admin folder even if that failed, as git does, then
    /// `<common dir>/worktrees` once empty. `remove_dir_all` unlinks symlinks, including `.git`,
    /// and never follows them.
    fn delete(self) -> Result<(), String> {
        let checkout = std::fs::remove_dir_all(&self.checkout)
            .map_err(|e| format!("failed to delete '{}': {e}", self.checkout.display()));
        let admin = std::fs::remove_dir_all(&self.admin)
            .map_err(|e| format!("failed to delete '{}': {e}", self.admin.display()));
        if let Some(worktrees) = self.admin.parent() {
            let _ = std::fs::remove_dir(worktrees);
        }
        checkout.and(admin)
    }
}

/// `resolve_gitdir_gently`, asked of git itself: `.git` is a git directory, or a `gitdir:`
/// file that names one. Git's own resolver handles a symlinked or packed `HEAD` and paths
/// with trailing spaces; a path git cannot be given counts as populated, so removal refuses.
async fn resolves_to_git_dir(cwd: &Path, dot_git: &Path) -> VcsResult<bool> {
    let Some(path) = dot_git.to_str() else {
        return Ok(true);
    };
    let output = git(
        "GitVcsDriver.removeWorktree",
        cwd,
        ["rev-parse", "--resolve-git-dir", path],
    )
    .allow_exit(&[128])
    .timeout(REMOVE_TIMEOUT)
    .run()
    .await?;
    if output.code == 0 {
        return Ok(true);
    }
    // Exit 128 is "no git dir here", but also "a git dir git cannot read". Only an absent
    // `.git` entry is unpopulated; anything else there counts as populated, so removal refuses.
    let dot_git = dot_git.to_owned();
    blocking(cwd, move || match std::fs::symlink_metadata(&dot_git) {
        Err(e) => e.kind() != std::io::ErrorKind::NotFound,
        Ok(_) => true,
    })
    .await
}

/// The admin folder `target` resolves to, when it is the repository's
/// `<common>/worktrees/<name>` and its `gitdir` names `worktree`'s own `.git`.
fn registered_admin(worktree: &Path, target: &Path, common: &Path) -> Option<PathBuf> {
    let admin = std::fs::canonicalize(target).ok()?;
    if admin.parent()? != common.join("worktrees") {
        return None;
    }
    let gitdir = std::fs::read_to_string(admin.join("gitdir")).ok()?;
    let backlink = admin.join(gitdir.trim());
    let names_dot_git = backlink.file_name()? == ".git"
        && std::fs::canonicalize(backlink.parent()?).ok()?
            == std::fs::canonicalize(worktree).ok()?;
    names_dot_git.then_some(admin)
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

/// Removes a worktree a launch made, then its branch: the branch goes only once the worktree
/// is gone, so an `Err` leaves both, and says why.
pub async fn discard(cwd: &Path, path: &Path, branch: &str) -> VcsResult<()> {
    remove_worktree(cwd, path, Removal::Force).await?;
    delete_branch(cwd, branch, Removal::Force).await
}

/// Whether this Git takes `git worktree add --lock --reason`.
async fn supports_lock_reason(cwd: &Path) -> bool {
    match git(OPERATION, cwd, ["worktree", "add", "-h"])
        .allow_exit(&[129])
        .run()
        .await
    {
        Ok(out) => out.stdout_text().contains("--reason") || out.stderr.contains("--reason"),
        Err(e) => e.stderr().contains("--reason"),
    }
}

/// Unlocks the worktree whose lock carries exactly `reason`, if one does. Reads Git's
/// registration files, as the TypeScript server does: Git before 2.36 has no `list -z`.
async fn unlock_registration(cwd: &Path, reason: &str) -> VcsResult<()> {
    let registrations = common_dir(cwd).await?.join("worktrees");
    let reason = reason.to_owned();
    let found = tokio::task::spawn_blocking(move || {
        let line = |text: String| {
            let text = text.strip_suffix('\n').unwrap_or(&text);
            text.strip_suffix('\r').unwrap_or(text).to_owned()
        };
        std::fs::read_dir(registrations)
            .ok()?
            .flatten()
            .find_map(|entry| {
                let admin = entry.path();
                let locked = std::fs::read_to_string(admin.join("locked")).ok()?;
                if line(locked) != reason {
                    return None;
                }
                // Relative to the registration under `worktree.useRelativePaths`.
                let gitdir = admin.join(line(std::fs::read_to_string(admin.join("gitdir")).ok()?));
                let path = gitdir.parent()?.to_owned();
                Some(std::fs::canonicalize(&path).unwrap_or(path))
            })
    })
    .await
    .map_err(|e| invalid(cwd, e.to_string()))?;
    if let Some(path) = found {
        git(
            "GitVcsDriver.createWorktree.unlock",
            cwd,
            [
                "worktree".to_owned(),
                "unlock".into(),
                "--".into(),
                path.to_string_lossy().into_owned(),
            ],
        )
        .run()
        .await?;
    }
    Ok(())
}

/// [`discard`] for a checkout a cancel cut short: first unlocks it when Git still holds the
/// claim's lock, since `git worktree remove --force` refuses a locked worktree.
pub async fn discard_claim(cwd: &Path, claim: &Claim, branch: &str) -> VcsResult<()> {
    if let Some(reason) = &claim.lock_reason {
        unlock_registration(cwd, reason).await?;
    }
    discard(cwd, &claim.path, branch).await
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
