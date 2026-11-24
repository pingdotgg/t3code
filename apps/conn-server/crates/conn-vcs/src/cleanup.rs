//! The Git checks before a managed worktree is removed, as T3's storage cleanup makes them
//! (`apps/server/src/storageCleanup.ts`). Each check answers with the reason to keep the
//! worktree, or `None`. A check that cannot finish keeps the worktree too.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use crate::{
    error::{VcsError, VcsResult},
    process::{OnLimit, ProcessError},
    repo::{git, optional_text, succeeds},
};

/// What local files keep a worktree (`worktreeKeepWhen`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum KeepWhen {
    /// Tracked edits, untracked files and ignored files other than `node_modules`.
    AnyLocalFiles,
    /// Tracked edits and untracked files. T3's default.
    #[default]
    UncommittedChanges,
    /// Tracked edits only; untracked and ignored files are deleted with the worktree.
    TrackedChanges,
}

impl KeepWhen {
    /// The setting's text; an unknown value is T3's default.
    pub fn from_setting(value: Option<&str>) -> Self {
        match value {
            Some("any-local-files") => Self::AnyLocalFiles,
            Some("tracked-changes") => Self::TrackedChanges,
            _ => Self::UncommittedChanges,
        }
    }
}

/// T3 reads at most this much of `status` and `ls-files`; more is too much to inspect.
const INSPECT_LIMIT: usize = 64 * 1024;
const FLAGGED_LIMIT: usize = 10_000;
const SUBMODULE_LIMIT: usize = 10_000;
const WALK_ENTRY_LIMIT: usize = 2_000_000;
const WALK_TIMEOUT: Duration = Duration::from_secs(30);
/// About 25,000 entries of a HEAD log; a longer one keeps the worktree.
const HEAD_LOG_LIMIT: usize = 1024 * 1024;
const LS_REMOTE_TIMEOUT: Duration = Duration::from_secs(20);

fn plural(count: usize) -> &'static str {
    if count == 1 { "file" } else { "files" }
}

/// `localChangesReason`: uncommitted changes, tracked changes git status hides, and (for
/// [`KeepWhen::AnyLocalFiles`]) ignored files other than `node_modules`.
pub async fn local_changes(cwd: &Path, keep: KeepWhen) -> VcsResult<Option<String>> {
    let untracked = if keep == KeepWhen::TrackedChanges {
        "--untracked-files=no"
    } else {
        "--untracked-files=all"
    };
    let status = git(
        "StorageCleanup.localChanges",
        cwd,
        [
            "status",
            "--porcelain=v1",
            "-z",
            "--ignore-submodules=none",
            untracked,
        ],
    )
    .max_stdout(INSPECT_LIMIT, OnLimit::Truncate)
    .run()
    .await?;
    if status.stdout_truncated {
        return Ok(Some("local changes exceed the inspection limit".into()));
    }
    let count = changed_records(&status.stdout);
    if count > 0 {
        return Ok(Some(format!(
            "has uncommitted changes ({count} {})",
            plural(count)
        )));
    }
    if let Some(hidden) = hidden_tracked_change(cwd).await? {
        return Ok(Some(hidden));
    }
    if keep != KeepWhen::AnyLocalFiles {
        return Ok(None);
    }
    let ignored = git(
        "StorageCleanup.ignoredFiles",
        cwd,
        [
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "-z",
        ],
    )
    .max_stdout(INSPECT_LIMIT, OnLimit::Truncate)
    .run()
    .await?;
    if ignored.stdout_truncated {
        return Ok(Some("ignored files exceed the inspection limit".into()));
    }
    let text = ignored.stdout_text();
    let file = text
        .split('\0')
        .find(|entry| !entry.is_empty() && !is_node_modules_dir(entry));
    Ok(file.map(|file| format!("has ignored files ({file})")))
}

/// `(^|/)node_modules/$`.
fn is_node_modules_dir(entry: &str) -> bool {
    entry == "node_modules/" || entry.ends_with("/node_modules/")
}

/// Porcelain v1 `-z` records; a rename or copy carries its source as one more record.
fn changed_records(stdout: &[u8]) -> usize {
    let mut records = stdout.split(|b| *b == 0).filter(|r| !r.is_empty());
    let mut count = 0;
    while let Some(record) = records.next() {
        count += 1;
        let renamed = |b: Option<&u8>| matches!(b, Some(b'R' | b'C'));
        if renamed(record.first()) || renamed(record.get(1)) {
            records.next();
        }
    }
    count
}

/// One `ls-files -s -v` entry flagged assume-unchanged or skip-worktree.
#[derive(Debug)]
struct Flagged {
    mode: String,
    id: String,
    file: String,
}

/// `<tag> <mode> <object> <stage>\t<path>`, when the tag passes `hidden`.
fn flagged_entry(line: &str, hidden: impl Fn(char) -> bool) -> Option<Flagged> {
    let (head, file) = line.split_once('\t')?;
    let mut fields = head.split(' ');
    let tag = fields.next()?;
    let mode = fields.next()?;
    let id = fields.next()?;
    let stage = fields.next()?;
    let mut tag_chars = tag.chars();
    let tag_char = tag_chars.next()?;
    let valid = tag_chars.next().is_none()
        && !mode.is_empty()
        && mode.bytes().all(|b| b.is_ascii_digit())
        && !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        && stage.len() == 1
        && stage.bytes().all(|b| b.is_ascii_digit())
        && fields.next().is_none();
    (valid && hidden(tag_char) && mode != "160000").then(|| Flagged {
        mode: mode.to_owned(),
        id: id.to_owned(),
        file: file.to_owned(),
    })
}

/// `hiddenTrackedChange`: git status and a non-forced removal both skip files flagged
/// assume-unchanged or skip-worktree. Hash the flagged files and compare them with the index.
async fn hidden_tracked_change(cwd: &Path) -> VcsResult<Option<String>> {
    let sparse = git(
        "StorageCleanup.hiddenTrackedChanges",
        cwd,
        [
            "config",
            "--type=bool",
            "--default=false",
            "core.sparseCheckout",
        ],
    )
    .text()
    .await?;
    // Sparse checkouts flag every file outside the cone; Git 2.37+ unflags those it finds.
    let sparse = sparse.trim() == "true";
    let file_mode = git(
        "StorageCleanup.hiddenTrackedChanges",
        cwd,
        ["config", "--type=bool", "--default=true", "core.fileMode"],
    )
    .text()
    .await?
    .trim()
        == "true";
    let hidden = move |tag: char| tag.is_ascii_lowercase() || (!sparse && tag == 'S');
    let mut flagged: Vec<Flagged> = Vec::new();
    let mut overflow = false;
    let mut carry: Vec<u8> = Vec::new();
    {
        let mut scan = |chunk: &[u8]| {
            carry.extend_from_slice(chunk);
            while let Some(end) = carry.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = carry.drain(..=end).collect();
                let line = String::from_utf8_lossy(line.get(..end).unwrap_or_default());
                if let Some(entry) = flagged_entry(&line, hidden) {
                    if flagged.len() < FLAGGED_LIMIT {
                        flagged.push(entry);
                    } else {
                        overflow = true;
                    }
                }
            }
        };
        git(
            "StorageCleanup.hiddenTrackedChanges",
            cwd,
            ["-c", "core.quotePath=false", "ls-files", "-s", "-v"],
        )
        .timeout(Duration::from_secs(120))
        .scan(&mut scan)
        .await?;
    }
    if overflow {
        return Ok(Some(
            "hidden tracked files exceed the inspection limit".into(),
        ));
    }
    let reason = |file: &str| format!("has uncommitted changes hidden from git status ({file})");
    // Quoted names and names that are not valid UTF-8 do not name the file on disk.
    if let Some(entry) = flagged
        .iter()
        .find(|e| e.file.starts_with('"') || e.file.contains('\u{FFFD}'))
    {
        return Ok(Some(reason(&entry.file)));
    }
    let root = cwd.to_owned();
    let on_disk = tokio::task::spawn_blocking(move || {
        flagged
            .into_iter()
            .filter_map(|entry| {
                let path = root.join(&entry.file);
                match std::fs::symlink_metadata(&path) {
                    Err(_) => None,
                    Ok(meta) if meta.is_symlink() => {
                        let target = std::fs::read_link(&path).ok();
                        Some((entry, OnDisk::Link(target)))
                    }
                    Ok(meta) if meta.is_file() => Some((entry, OnDisk::File(executable(&meta)))),
                    Ok(_) => Some((entry, OnDisk::Other)),
                }
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| {
        VcsError::invalid(
            "StorageCleanup.hiddenTrackedChanges",
            &cwd.to_string_lossy(),
            e.to_string(),
        )
    })?;
    let mut files: Vec<Flagged> = Vec::new();
    // Without core.symlinks a tracked link is a regular file holding its target.
    let mut link_files: Vec<Flagged> = Vec::new();
    for (entry, disk) in on_disk {
        match disk {
            OnDisk::File(_) if entry.mode == "120000" => link_files.push(entry),
            // Git status would show a changed executable bit, and removal drops it.
            OnDisk::File(executable) if file_mode && executable != (entry.mode == "100755") => {
                return Ok(Some(reason(&entry.file)));
            }
            OnDisk::File(_) => files.push(entry),
            OnDisk::Link(Some(target)) if entry.mode == "120000" => {
                // Hashing a link's path would hash the file it points to.
                let id = git(
                    "StorageCleanup.hiddenTrackedChanges",
                    cwd,
                    ["hash-object", "--stdin"],
                )
                .stdin(target.as_os_str().as_encoded_bytes().to_vec())
                .text()
                .await?;
                if id.trim() != entry.id {
                    return Ok(Some(reason(&entry.file)));
                }
            }
            OnDisk::Link(_) | OnDisk::Other => return Ok(Some(reason(&entry.file))),
        }
    }
    for (entries, filters) in [(&files, None), (&link_files, Some("--no-filters"))] {
        if entries.is_empty() {
            continue;
        }
        let mut args = vec!["hash-object"];
        args.extend(filters);
        args.push("--stdin-paths");
        let paths: String = entries.iter().map(|e| format!("{}\n", e.file)).collect();
        let ids = git("StorageCleanup.hiddenTrackedChanges", cwd, args)
            .stdin(paths.into_bytes())
            .text()
            .await?;
        let ids: Vec<&str> = ids.split('\n').collect();
        for (index, entry) in entries.iter().enumerate() {
            if ids.get(index).copied() != Some(entry.id.as_str()) {
                return Ok(Some(reason(&entry.file)));
            }
        }
    }
    Ok(None)
}

enum OnDisk {
    /// A regular file, and whether its owner may execute it.
    File(bool),
    Link(Option<PathBuf>),
    Other,
}

#[cfg(unix)]
fn executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o100 != 0
}

#[cfg(not(unix))]
fn executable(_meta: &std::fs::Metadata) -> bool {
    false
}

/// `branchChanged`: whether the checkout no longer has `branch` checked out. A folder that is
/// gone or no longer a repository counts as changed. A held index lock is an error, so the
/// worktree is kept until the lock goes.
pub async fn branch_changed(cwd: &Path, branch: Option<&str>) -> VcsResult<bool> {
    let read = |args: &'static [&'static str]| {
        git("StorageCleanup.branchChanged", cwd, args.iter().copied()).env("LC_ALL", "C")
    };
    if !is_dir(cwd).await {
        return Ok(true);
    }
    let Some(index) = optional_text(read(&["rev-parse", "--git-path", "index"])).await? else {
        return Ok(true);
    };
    let lock = cwd.join(format!("{index}.lock"));
    if is_present(&lock).await {
        return Err(VcsError::invalid(
            "StorageCleanup.branchChanged",
            &cwd.to_string_lossy(),
            "Git index is locked. Status will resume when the index lock is removed.",
        ));
    }
    // Detached HEAD exits 1; full refs avoid shortening when a tag shares the branch name.
    let head = match read(&["symbolic-ref", "--quiet", "HEAD"]).run().await {
        Ok(out) => out.stdout_text().trim().to_owned(),
        Err(ProcessError::Exit { code: 1, .. }) => String::new(),
        Err(ProcessError::Exit { .. }) => return Ok(true),
        Err(e) => return Err(e.into()),
    };
    let name = head.strip_prefix("refs/heads/").map(str::trim);
    Ok(name != branch)
}

async fn is_dir(path: &Path) -> bool {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || path.is_dir())
        .await
        .unwrap_or(false)
}

async fn is_present(path: &Path) -> bool {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || path.symlink_metadata().is_ok())
        .await
        .unwrap_or(false)
}

/// `isLinkedWorktree`: a checkout whose Git dir is not its repository's common dir. This
/// holds for a `gitdir:` file and for git-annex's symlinked `.git`.
pub async fn is_linked_worktree(path: &Path) -> bool {
    if !is_present(&path.join(".git")).await {
        return false;
    }
    let read = |args: &'static [&'static str]| {
        optional_text(git(
            "StorageCleanup.isLinkedWorktree",
            path,
            args.iter().copied(),
        ))
    };
    let (Ok(Some(dir)), Ok(Some(common)), Ok(Some(top))) = (
        read(&["rev-parse", "--path-format=absolute", "--git-dir"]).await,
        read(&["rev-parse", "--path-format=absolute", "--git-common-dir"]).await,
        read(&["rev-parse", "--show-toplevel"]).await,
    ) else {
        return false;
    };
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let at_top = match (std::fs::canonicalize(&top), std::fs::canonicalize(&path)) {
            (Ok(top), Ok(real)) => top == real,
            _ => false,
        };
        at_top && canonical(&dir) != canonical(&common)
    })
    .await
    .unwrap_or(false)
}

/// Blocking.
fn canonical(path: &str) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path))
}

/// `worktreeRepository`: the repository that registered the worktree. A project can move to
/// another clone, and git removes a worktree only through its own repository.
pub async fn owning_repository(worktree: &Path) -> VcsResult<PathBuf> {
    let common = git(
        "StorageCleanup.worktreeRepository",
        worktree,
        ["rev-parse", "--git-common-dir"],
    )
    .text()
    .await?;
    let resolved = worktree.join(common.trim());
    Ok(if resolved.file_name().is_some_and(|n| n == ".git") {
        resolved.parent().map_or(resolved.clone(), Path::to_owned)
    } else {
        resolved
    })
}

/// What [`submodule_removal`] found.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SubmoduleRemoval {
    /// Git refuses to remove a worktree with submodules without `--force`.
    pub force: bool,
    /// The reason to keep the worktree.
    pub reason: Option<String>,
}

/// `submoduleRemoval`: removing a worktree deletes its submodules' repositories. Keep it when
/// a submodule has commits on no remote-tracking ref, has local changes, or a deinitialized
/// submodule folder still holds files.
pub async fn submodule_removal(cwd: &Path, keep: KeepWhen) -> SubmoduleRemoval {
    match submodule_inspection(cwd, keep).await {
        Ok(found) => found,
        Err(_) => SubmoduleRemoval {
            force: false,
            reason: Some("submodules could not be inspected".into()),
        },
    }
}

fn keep_for(reason: &str) -> SubmoduleRemoval {
    SubmoduleRemoval {
        force: false,
        reason: Some(reason.into()),
    }
}

async fn submodule_inspection(cwd: &Path, keep: KeepWhen) -> VcsResult<SubmoduleRemoval> {
    let inspect = |args: Vec<String>, limit: usize| {
        git("StorageCleanup.submodules", cwd, args).max_stdout(limit, OnLimit::Truncate)
    };
    let limited = "submodule inspection exceeded the limit";
    let admin = inspect(
        vec!["rev-parse".into(), "--absolute-git-dir".into()],
        INSPECT_LIMIT,
    )
    .run()
    .await?;
    if admin.stdout_truncated {
        return Ok(keep_for(limited));
    }
    let admin_text = admin.stdout_text();
    let modules = PathBuf::from(admin_text.trim_end_matches('\n')).join("modules");
    let stored = is_present(&modules).await;
    if !stored && !is_present(&cwd.join(".gitmodules")).await {
        return Ok(SubmoduleRemoval::default());
    }
    let populated = inspect(
        [
            "submodule",
            "foreach",
            "--recursive",
            "--quiet",
            "printf \"%s\\0\" \"$toplevel/$sm_path\"",
        ]
        .map(str::to_owned)
        .to_vec(),
        INSPECT_LIMIT,
    )
    .run()
    .await?;
    if populated.stdout_truncated {
        return Ok(keep_for(limited));
    }
    let paths: Vec<PathBuf> = populated
        .stdout_text()
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .collect();
    let mut pending = vec![modules];
    for submodule in &paths {
        let dir = inspect(
            vec![
                "-C".into(),
                submodule.to_string_lossy().into_owned(),
                "rev-parse".into(),
                "--absolute-git-dir".into(),
            ],
            INSPECT_LIMIT,
        )
        .run()
        .await?;
        if dir.stdout_truncated {
            return Ok(keep_for(limited));
        }
        pending.push(PathBuf::from(dir.stdout_text().trim_end_matches('\n')));
    }
    let mut visited: HashSet<PathBuf> = HashSet::new();
    while let Some(directory) = pending.pop() {
        let listed = {
            let directory = directory.clone();
            tokio::task::spawn_blocking(move || list_store(&directory))
                .await
                .unwrap_or(Stored::Unreadable)
        };
        let (real, repository, children) = match listed {
            Stored::Missing => continue,
            Stored::Unreadable => {
                return Ok(keep_for("submodule repository could not be inspected"));
            }
            Stored::Repository(real) => (real, true, Vec::new()),
            Stored::Folder(real, children) => (real, false, children),
        };
        if !visited.insert(real) {
            continue;
        }
        if visited.len() > SUBMODULE_LIMIT {
            return Ok(keep_for(limited));
        }
        if repository {
            let unpushed = inspect(
                vec![
                    "--git-dir".into(),
                    directory.to_string_lossy().into_owned(),
                    "--work-tree".into(),
                    cwd.to_string_lossy().into_owned(),
                    "rev-list".into(),
                    "--max-count=1".into(),
                    "HEAD".into(),
                    // Checkpoint refs hold workspace snapshots, not commits a user could lose.
                    "--exclude=refs/t3/*".into(),
                    "--all".into(),
                    "--reflog".into(),
                    "--not".into(),
                    "--remotes".into(),
                ],
                INSPECT_LIMIT,
            )
            .run()
            .await?;
            if unpushed.stdout_truncated {
                return Ok(keep_for(limited));
            }
            if !unpushed.stdout_text().trim().is_empty() {
                return Ok(keep_for(
                    "submodule has commits not on a remote-tracking ref",
                ));
            }
            pending.push(directory.join("modules"));
        } else {
            pending.extend(children);
        }
    }
    // Files are checked after the stored history, to shorten the gap before a forced removal.
    for submodule in &paths {
        if let Some(changes) = Box::pin(local_changes(submodule, keep)).await? {
            return Ok(keep_for(&format!("submodule {changes}")));
        }
    }
    let force = stored || !paths.is_empty();
    if force && keep != KeepWhen::TrackedChanges {
        // Git status and foreach omit files inside deinitialized gitlink folders.
        let (root, populated) = {
            let (owned, paths) = (cwd.to_owned(), paths.clone());
            tokio::task::spawn_blocking(move || {
                let populated: HashSet<PathBuf> = paths
                    .iter()
                    .map(|p| canonical(&p.to_string_lossy()))
                    .collect();
                (canonical(&owned.to_string_lossy()), populated)
            })
            .await
            .map_err(|e| {
                VcsError::invalid(
                    "StorageCleanup.submodules",
                    &cwd.to_string_lossy(),
                    e.to_string(),
                )
            })?
        };
        let mut unchecked: Vec<PathBuf> = Vec::new();
        for repository in std::iter::once(root.clone()).chain(paths.iter().cloned()) {
            let index = inspect(
                vec![
                    "-C".into(),
                    repository.to_string_lossy().into_owned(),
                    "ls-files".into(),
                    "--stage".into(),
                    "-z".into(),
                ],
                16 * 1024 * 1024,
            )
            .run()
            .await?;
            if index.stdout_truncated {
                return Ok(keep_for(limited));
            }
            for entry in index.stdout_text().split('\0') {
                let Some(rest) = entry.strip_prefix("160000 ") else {
                    continue;
                };
                let Some((_, relative)) = rest.split_once('\t') else {
                    continue;
                };
                let submodule = repository.join(relative);
                if !submodule.starts_with(&root) {
                    return Ok(keep_for("submodules could not be inspected"));
                }
                if is_present(&submodule).await {
                    unchecked.push(submodule);
                }
            }
        }
        let has_files = tokio::task::spawn_blocking(move || {
            unchecked.retain(|s| !populated.contains(&canonical(&s.to_string_lossy())));
            let mut inspected = unchecked.len();
            while let Some(target) = unchecked.pop() {
                if inspected > SUBMODULE_LIMIT {
                    return Some(limited);
                }
                let real = std::fs::canonicalize(&target).ok();
                let is_dir = std::fs::metadata(&target).is_ok_and(|m| m.is_dir());
                if real.as_deref() != Some(target.as_path()) || !is_dir {
                    return Some("submodule has local files");
                }
                if target.file_name().is_some_and(|n| n == "node_modules") {
                    continue;
                }
                let Ok(entries) = std::fs::read_dir(&target) else {
                    return Some("submodules could not be inspected");
                };
                for entry in entries.flatten() {
                    inspected += 1;
                    unchecked.push(entry.path());
                }
            }
            None
        })
        .await
        .unwrap_or(Some("submodules could not be inspected"));
        if let Some(reason) = has_files {
            return Ok(keep_for(reason));
        }
    }
    Ok(SubmoduleRemoval {
        force,
        reason: None,
    })
}

/// One folder of a submodule store, as [`submodule_inspection`] walks it.
enum Stored {
    Missing,
    Unreadable,
    /// A repository (it has `HEAD`), by its real path.
    Repository(PathBuf),
    /// Another folder, by its real path, and its entries.
    Folder(PathBuf, Vec<PathBuf>),
}

/// Blocking.
fn list_store(directory: &Path) -> Stored {
    if !directory.exists() {
        return Stored::Missing;
    }
    let (Ok(real), Ok(meta)) = (
        std::fs::canonicalize(directory),
        std::fs::metadata(directory),
    ) else {
        return Stored::Unreadable;
    };
    if !meta.is_dir() {
        return Stored::Unreadable;
    }
    if directory.join("HEAD").exists() {
        return Stored::Repository(real);
    }
    match std::fs::read_dir(directory)
        .and_then(|entries| entries.map(|e| e.map(|e| e.path())).collect())
    {
        Ok(children) => Stored::Folder(real, children),
        Err(_) => Stored::Unreadable,
    }
}

/// The part of `measureWorktree` that guards removal: git status omits ignored repositories,
/// and a worktree removal deletes them. Walks the checkout without following links; registered
/// submodules are checked by [`submodule_removal`]. Blocking: run it on a blocking thread.
pub fn nested_repository(root: &Path, submodules: &[PathBuf]) -> Option<&'static str> {
    const INCOMPLETE: &str = "worktree could not be fully inspected";
    let Ok(root) = std::fs::canonicalize(root) else {
        return Some(INCOMPLETE);
    };
    let mut known: HashSet<PathBuf> = HashSet::from([root.clone()]);
    let mut stores: Vec<PathBuf> = Vec::new();
    for submodule in submodules {
        let submodule = canonical(&submodule.to_string_lossy());
        known.insert(submodule.join(".git"));
        stores.push(submodule.join(".git").join("modules"));
        known.insert(submodule);
    }
    let started = Instant::now();
    let mut pending = vec![root];
    let mut entries = 1usize;
    while let Some(target) = pending.pop() {
        if started.elapsed() > WALK_TIMEOUT {
            return Some(INCOMPLETE);
        }
        let Ok(meta) = std::fs::symlink_metadata(&target) else {
            return Some(INCOMPLETE);
        };
        if meta.is_symlink() || !meta.is_dir() {
            continue;
        }
        if std::fs::canonicalize(&target).ok().as_deref() != Some(target.as_path()) {
            return Some(INCOMPLETE);
        }
        let Ok(listing) = std::fs::read_dir(&target) else {
            return Some(INCOMPLETE);
        };
        let mut names: Vec<String> = Vec::new();
        let mut children: Vec<PathBuf> = Vec::new();
        for entry in listing {
            let Ok(entry) = entry else {
                return Some(INCOMPLETE);
            };
            names.push(entry.file_name().to_string_lossy().to_lowercase());
            children.push(entry.path());
        }
        let in_store = stores.iter().any(|s| target.starts_with(s));
        if !known.contains(&target) && !in_store {
            let has = |name: &str| names.iter().any(|n| n == name);
            if has(".git") || (has("head") && has("objects") && has("refs")) {
                return Some("contains a nested Git repository");
            }
        }
        entries += names.len();
        if entries > WALK_ENTRY_LIMIT {
            return Some(INCOMPLETE);
        }
        pending.extend(children);
    }
    None
}

/// The registered submodule checkouts below `cwd`, for [`nested_repository`].
pub async fn submodule_paths(cwd: &Path) -> VcsResult<Option<Vec<PathBuf>>> {
    if !is_present(&cwd.join(".gitmodules")).await {
        return Ok(Some(Vec::new()));
    }
    let out = git(
        "StorageCleanup.nestedRepositories",
        cwd,
        [
            "submodule",
            "foreach",
            "--recursive",
            "--quiet",
            "printf \"%s\\0\" \"$toplevel/$sm_path\"",
        ],
    )
    .max_stdout(INSPECT_LIMIT, OnLimit::Truncate)
    .run()
    .await?;
    if out.stdout_truncated {
        return Ok(None);
    }
    Ok(Some(
        out.stdout_text()
            .split('\0')
            .filter(|p| !p.is_empty())
            .map(PathBuf::from)
            .collect(),
    ))
}

/// The remote's default branch: `refs/remotes/<remote>/HEAD`, else the remote's own answer
/// (`ls-remote --symref`). Only the remote can name it: a local `main` may be a feature branch.
pub async fn remote_default_branch(root: &Path, remote: &str) -> VcsResult<Option<String>> {
    if let Some(branch) = crate::repo::remote_default_branch(root, remote).await? {
        return Ok(Some(branch));
    }
    let listed = git(
        "StorageCleanup.resolveDefaultBranch",
        root,
        ["ls-remote", "--symref", "--", remote, "HEAD"],
    )
    .timeout(LS_REMOTE_TIMEOUT)
    .run()
    .await;
    let Ok(listed) = listed else {
        return Ok(None);
    };
    Ok(listed.stdout_text().lines().find_map(|line| {
        line.trim_end_matches('\r')
            .strip_prefix("ref: refs/heads/")?
            .strip_suffix("\tHEAD")
            .map(str::to_owned)
    }))
}

/// Updates `refs/remotes/<remote>/<branch>` from the remote.
pub async fn fetch_tracking_branch(root: &Path, remote: &str, branch: &str) -> VcsResult<()> {
    git(
        "GitVcsDriver.fetchRemoteTrackingBranch",
        root,
        [
            "fetch".to_owned(),
            "--quiet".into(),
            "--no-tags".into(),
            remote.to_owned(),
            format!("+refs/heads/{branch}:refs/remotes/{remote}/{branch}"),
        ],
    )
    .timeout(Duration::from_secs(60))
    .run()
    .await?;
    Ok(())
}

/// The project's checked-out branch ref (`refs/heads/<name>`), or `None` when detached.
pub async fn project_branch_ref(root: &Path) -> VcsResult<Option<String>> {
    optional_text(git(
        "StorageCleanup.resolveProjectBranch",
        root,
        ["symbolic-ref", "--quiet", "HEAD"],
    ))
    .await
}

/// `merge-base --is-ancestor`.
pub async fn is_ancestor(cwd: &Path, commit: &str, of: &str) -> VcsResult<bool> {
    succeeds(git(
        "StorageCleanup.integratedBranch",
        cwd,
        ["merge-base", "--is-ancestor", commit, of],
    ))
    .await
}

/// `git worktree lock` holds the worktree: Git refuses to remove it without `-f -f`.
pub async fn is_locked(cwd: &Path) -> VcsResult<bool> {
    let admin = git(
        "StorageCleanup.worktreeLock",
        cwd,
        ["rev-parse", "--absolute-git-dir"],
    )
    .text()
    .await?;
    Ok(is_present(&Path::new(admin.trim_end_matches('\n')).join("locked")).await)
}

/// The checkout's own HEAD log names a commit that no ref and no other reflog keeps, such as
/// one made on a detached HEAD. `git worktree remove` deletes that log. `repository` is the
/// main checkout (see [`owning_repository`]). Checkpoint refs do not count: T3 prunes them.
pub async fn head_log_holds_lost_commits(cwd: &Path, repository: &Path) -> VcsResult<bool> {
    let log = git(
        "StorageCleanup.headLog",
        cwd,
        ["log", "--walk-reflogs", "--format=%H", "HEAD"],
    )
    .max_stdout(HEAD_LOG_LIMIT, OnLimit::Truncate)
    .run()
    .await?;
    if log.stdout_truncated {
        return Ok(true);
    }
    let commits: HashSet<String> = log
        .stdout_text()
        .lines()
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect();
    if commits.is_empty() {
        return Ok(false);
    }
    let stdin: String = commits.iter().map(|c| format!("{c}\n")).collect();
    // From the main checkout, `--single-worktree` leaves out every linked HEAD and its log;
    // branch reflogs stay, so an amended or rebased commit is still kept by its branch's log.
    let lost = git(
        "StorageCleanup.headLog",
        repository,
        [
            "rev-list",
            "--max-count=1",
            "--stdin",
            "--not",
            "--single-worktree",
            "--exclude=refs/t3/*",
            "--all",
            "--reflog",
        ],
    )
    .stdin(stdin.into_bytes())
    .text()
    .await?;
    Ok(!lost.trim().is_empty())
}

/// The commit `revision` names in `cwd`. Unlike `repo::resolve_commit`, a missing folder is
/// Git's error, so no blocking check runs on the runtime thread.
pub async fn commit_of(cwd: &Path, revision: &str) -> VcsResult<Option<String>> {
    Ok(optional_text(git(
        "GitVcsDriver.resolveCommit",
        cwd,
        [
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{revision}^{{commit}}"),
        ],
    ))
    .await?
    .filter(|sha| !sha.is_empty()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_status_records_with_rename_sources() {
        assert_eq!(changed_records(b""), 0);
        assert_eq!(changed_records(b" M a\0?? b\0"), 2);
        assert_eq!(changed_records(b"R  new\0old\0 M c\0"), 2);
        assert_eq!(changed_records(b" C new\0old\0"), 1);
    }

    #[test]
    fn reads_flagged_ls_files_entries() {
        let hidden = |tag: char| tag.is_ascii_lowercase() || tag == 'S';
        let entry = flagged_entry("h 100644 0123abcd 0\tsrc/a b.rs", hidden).map(|e| e.file);
        assert_eq!(entry.as_deref(), Some("src/a b.rs"));
        assert!(flagged_entry("H 100644 0123abcd 0\tsrc/a.rs", hidden).is_none());
        assert!(
            flagged_entry("S 160000 0123abcd 0\tsub", hidden).is_none(),
            "gitlink"
        );
        assert!(flagged_entry("S 100644 0123abcd 0\tsparse.rs", hidden).is_some());
        assert!(flagged_entry("garbage", hidden).is_none());
    }

    #[test]
    fn node_modules_folders_are_not_local_files() {
        assert!(is_node_modules_dir("node_modules/"));
        assert!(is_node_modules_dir("apps/web/node_modules/"));
        assert!(!is_node_modules_dir("node_modules.txt"));
        assert!(!is_node_modules_dir(".env"));
    }
}
