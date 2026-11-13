//! `review.getDiffPreview`, `review.getDiffFileContents`, `review.getBranchCommits`.
//!
//! Behaviour follows `GitVcsDriverCore.ts` (`getReviewDiffPreview` and friends): the same git
//! arguments, the same byte limits, and the same sources. Untracked files show as additions
//! through a throwaway copy of the index with `--intent-to-add`, so the real index is never
//! written.

use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use conn_contract::support::JsNumber;
use conn_contract::{
    ReviewBranchCommitsInput, ReviewBranchCommitsResult, ReviewBranchCommitsResultCommitsItem,
    ReviewDiffFileContentsInput, ReviewDiffFileContentsInputChangeType as ChangeType,
    ReviewDiffFileContentsResult, ReviewDiffFileStat, ReviewDiffPreviewInput,
    ReviewDiffPreviewInputSourceKind, ReviewDiffPreviewResult, ReviewDiffPreviewSource,
    ReviewDiffPreviewSourceKind,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    clock,
    error::{VcsError, VcsResult},
    process::{GitCommand, OnLimit, ProcessError},
    repo::{self, PROBE_TIMEOUT, git},
};

pub const PATCH_MAX_BYTES: usize = 120_000;
pub const FILE_MAX_BYTES: usize = 1_048_576;
pub const METADATA_MAX_BYTES: usize = 16 * 1024 * 1024;
pub const UNTRACKED_MAX_FILES: usize = 5_000;
pub const BRANCH_COMMIT_LIMIT: usize = 100;
pub const SUBJECT_LIMIT: usize = 300;
pub const BRANCH_COMMIT_MAX_BYTES: usize = 131_072;

const DIFF_ARGS: &[&str] = &[
    "-c",
    "diff.suppressBlankEmpty=false",
    "diff",
    "--find-renames",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--submodule=short",
    "--src-prefix=a/",
    "--dst-prefix=b/",
];

fn literal_pathspec(path: &str) -> String {
    format!(":(top,literal){path}")
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub path: String,
    pub previous_path: Option<String>,
    pub additions: u64,
    pub deletions: u64,
}

impl FileStat {
    fn to_contract(&self) -> ReviewDiffFileStat {
        ReviewDiffFileStat {
            path: self.path.clone(),
            previous_path: self.previous_path.clone(),
            additions: JsNumber(self.additions as f64),
            deletions: JsNumber(self.deletions as f64),
        }
    }
}

/// Parses `git diff --numstat -z`. A rename has an empty path field followed by the old and the
/// new path. Binary files count 0/0.
pub fn parse_numstat(output: &str) -> Vec<FileStat> {
    let mut files = Vec::new();
    let mut fields = output.split('\0');
    while let Some(field) = fields.next() {
        let mut parts = field.splitn(3, '\t');
        let (Some(add), Some(del), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let count = |s: &str| {
            if s == "-" {
                Some(0)
            } else {
                s.parse::<u64>().ok()
            }
        };
        let (Some(additions), Some(deletions)) = (count(add), count(del)) else {
            continue;
        };
        if path.is_empty() {
            let (Some(old), Some(new)) = (fields.next(), fields.next()) else {
                break;
            };
            files.push(FileStat {
                path: new.to_owned(),
                previous_path: Some(old.to_owned()),
                additions,
                deletions,
            });
        } else {
            files.push(FileStat {
                path: path.to_owned(),
                previous_path: None,
                additions,
                deletions,
            });
        }
    }
    files
}

/// `sha256(JSON.stringify([diff, files]))`, lowercase hex.
pub fn diff_hash(diff: &str, files: &[FileStat]) -> String {
    let json = serde_json::to_string(&(diff, files)).expect("serializable");
    let digest = Sha256::digest(json.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

struct TrackedDiff {
    diff: String,
    truncated: bool,
    files: Option<Vec<FileStat>>,
}

impl TrackedDiff {
    fn empty() -> Self {
        Self {
            diff: String::new(),
            truncated: false,
            files: Some(Vec::new()),
        }
    }
}

/// A throwaway index file, removed on drop.
pub(crate) struct TempIndex(PathBuf);

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn temp_index_path() -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    std::env::temp_dir().join(format!(
        "conn-review-index-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}

pub(crate) enum Untracked {
    /// Diffs run as usual.
    None,
    /// Diffs run with `GIT_INDEX_FILE` set to this copy, which marks the untracked files.
    Index(TempIndex),
    /// Too many (or too large) untracked files, or `ls-files` failed: stats are incomplete.
    Unavailable,
}

impl Untracked {
    pub(crate) fn index(&self) -> Option<&Path> {
        match self {
            Untracked::Index(temp) => Some(temp.0.as_path()),
            _ => None,
        }
    }
}

/// Status totals stop counting untracked files above this many bytes in all.
pub const UNTRACKED_TOTALS_MAX_BYTES: u64 = 256 * 1024 * 1024;

pub(crate) async fn prepare_untracked(
    cwd: &Path,
    paths: &[String],
    file: Option<&str>,
    max_total_bytes: Option<u64>,
) -> VcsResult<Untracked> {
    let mut args = vec![
        "ls-files".to_owned(),
        "--others".into(),
        "--exclude-standard".into(),
        "-z".into(),
        "--".into(),
    ];
    args.extend(paths.iter().cloned());
    let listed = match git("GitVcsDriver.listUntracked", cwd, args)
        .max_stdout(METADATA_MAX_BYTES, OnLimit::Fail)
        .run()
        .await
    {
        Ok(out) => out.stdout_text(),
        Err(_) => return Ok(Untracked::Unavailable),
    };
    let mut untracked: Vec<String> = listed
        .split('\0')
        .filter(|p| !p.is_empty())
        .filter(|p| match file {
            Some(f) => *p == f || p.strip_suffix('/') == Some(f),
            None => true,
        })
        .map(str::to_owned)
        .collect();
    if untracked.is_empty() {
        return Ok(Untracked::None);
    }
    if untracked.len() > UNTRACKED_MAX_FILES {
        return Ok(Untracked::Unavailable);
    }

    let deleted = git(
        "GitVcsDriver.stagedDeletions",
        cwd,
        [
            "diff",
            "--cached",
            "--no-renames",
            "--name-only",
            "--diff-filter=D",
            "-z",
            "HEAD",
            "--",
        ],
    )
    .max_stdout(METADATA_MAX_BYTES, OnLimit::Truncate)
    .allow_exit(&[1, 128])
    .run()
    .await?
    .stdout_text();
    let deleted: Vec<&str> = deleted.split('\0').filter(|p| !p.is_empty()).collect();
    untracked.retain(|p| !deleted.contains(&p.as_str()));
    if untracked.is_empty() {
        return Ok(Untracked::None);
    }
    if let Some(limit) = max_total_bytes {
        let root = cwd.to_owned();
        let list = untracked.clone();
        let total = tokio::task::spawn_blocking(move || {
            list.iter()
                .filter_map(|p| std::fs::symlink_metadata(root.join(p)).ok())
                .filter(|m| m.is_file())
                .map(|m| m.len())
                .sum::<u64>()
        })
        .await
        .unwrap_or(u64::MAX);
        if total > limit {
            return Ok(Untracked::Unavailable);
        }
    }

    let real_index = git(
        "GitVcsDriver.prepareReviewIndex",
        cwd,
        ["rev-parse", "--path-format=absolute", "--git-path", "index"],
    )
    .text()
    .await?
    .trim()
    .to_owned();
    let temp = TempIndex(temp_index_path());
    let copy_target = temp.0.clone();
    let source = PathBuf::from(real_index);
    let copied = tokio::task::spawn_blocking(move || copy_index(&source, &copy_target))
        .await
        .map_err(|_| prepare_error(cwd))?
        .map_err(|_| prepare_error(cwd))?;
    let index_env = temp.0.clone().into_os_string();
    if !copied {
        git(
            "GitVcsDriver.prepareReviewIndex",
            cwd,
            ["read-tree", "--empty"],
        )
        .env("GIT_INDEX_FILE", index_env.clone())
        .run()
        .await?;
    }
    git(
        "GitVcsDriver.prepareReviewIndex",
        cwd,
        [
            "-c",
            "core.splitIndex=false",
            "-c",
            "splitIndex.sharedIndexExpire=never",
            "update-index",
            "--no-split-index",
        ],
    )
    .env("GIT_INDEX_FILE", index_env.clone())
    .run()
    .await?;
    let mut list = Vec::new();
    for path in &untracked {
        list.extend_from_slice(path.as_bytes());
        list.push(0);
    }
    git(
        "GitVcsDriver.prepareReviewIndex",
        cwd,
        [
            "-c",
            "core.splitIndex=false",
            "-c",
            "splitIndex.sharedIndexExpire=never",
            "-c",
            "core.preloadIndex=false",
            "-c",
            "core.sparseCheckout=false",
            "--literal-pathspecs",
            "add",
            "--intent-to-add",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
        ],
    )
    .env("GIT_INDEX_FILE", index_env)
    .stdin(list)
    .run()
    .await?;
    Ok(Untracked::Index(temp))
}

fn prepare_error(cwd: &Path) -> VcsError {
    VcsError::invalid(
        "GitVcsDriver.prepareReviewIndex",
        &cwd.to_string_lossy(),
        "Could not prepare the review index.",
    )
}

/// Copies the index and keeps its mtime (to the second) so racily clean entries stay checked.
/// Returns false when the repository has no index yet.
fn copy_index(source: &Path, target: &Path) -> std::io::Result<bool> {
    let meta = match std::fs::metadata(source) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    std::fs::copy(source, target)?;
    if let Ok(modified) = meta.modified() {
        let secs = modified
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let floored = std::time::UNIX_EPOCH + Duration::from_secs(secs);
        let file = std::fs::OpenOptions::new().write(true).open(target)?;
        file.set_times(
            std::fs::FileTimes::new()
                .set_modified(floored)
                .set_accessed(floored),
        )?;
    }
    Ok(true)
}

struct DiffRequest<'a> {
    cwd: &'a Path,
    diff_args: Vec<String>,
    paths: &'a [String],
    patch_limit: usize,
    index: Option<&'a Path>,
}

impl DiffRequest<'_> {
    fn command(&self, operation: &'static str, extra: &[&str], refs: &[&str]) -> GitCommand {
        let mut args: Vec<String> = self.diff_args.clone();
        args.extend(extra.iter().map(|s| (*s).to_owned()));
        args.extend(refs.iter().map(|s| (*s).to_owned()));
        args.push("--".into());
        args.extend(self.paths.iter().cloned());
        let mut command = git(operation, self.cwd, args);
        if let Some(index) = self.index {
            command = command.env("GIT_INDEX_FILE", index.as_os_str().to_owned());
        }
        command
    }

    async fn read(&self, reference: Option<&str>, metadata_only: bool) -> VcsResult<TrackedDiff> {
        let Some(reference) = reference else {
            return Ok(TrackedDiff::empty());
        };
        let mut reference = reference.to_owned();
        let stat = match self
            .command(
                "GitVcsDriver.getReviewDiffPreview.stat",
                &["--numstat", "-z"],
                &[&reference],
            )
            .max_stdout(METADATA_MAX_BYTES, OnLimit::Fail)
            .run()
            .await
        {
            Ok(out) => out.stdout_text(),
            Err(ProcessError::Exit { stderr, code, .. }) => {
                let lower = stderr.to_ascii_lowercase();
                let unborn = reference == "HEAD"
                    && (lower.contains("bad revision 'head'")
                        || (lower.contains("unknown revision")
                            && lower.contains("path not in the working tree"))
                        || lower.contains("ambiguous argument 'head'"));
                if !unborn {
                    return Err(VcsError::invalid(
                        "GitVcsDriver.getReviewDiffPreview.stat",
                        &self.cwd.to_string_lossy(),
                        format!("Could not read complete diff statistics (exit {code})."),
                    ));
                }
                reference = repo::empty_tree(self.cwd).await?;
                self.command(
                    "GitVcsDriver.getReviewDiffPreview.stat",
                    &["--numstat", "-z"],
                    &[&reference],
                )
                .max_stdout(METADATA_MAX_BYTES, OnLimit::Fail)
                .text()
                .await?
            }
            Err(e) => return Err(e.into()),
        };
        let files = parse_numstat(&stat);
        if metadata_only || files.is_empty() {
            return Ok(TrackedDiff {
                diff: String::new(),
                truncated: false,
                files: Some(files),
            });
        }
        let patch = self
            .command(
                "GitVcsDriver.getReviewDiffPreview.patch",
                &["--patch"],
                &[&reference],
            )
            .max_stdout(self.patch_limit, OnLimit::Truncate)
            .run()
            .await?;
        Ok(TrackedDiff {
            diff: patch.stdout_text(),
            truncated: patch.stdout_truncated,
            files: Some(files),
        })
    }
}

fn source(
    id: &str,
    kind: ReviewDiffPreviewSourceKind,
    title: String,
    base_ref: Option<String>,
    head_ref: Option<String>,
    diff: TrackedDiff,
    deferred: bool,
) -> ReviewDiffPreviewSource {
    let hash = diff_hash(&diff.diff, diff.files.as_deref().unwrap_or(&[]));
    ReviewDiffPreviewSource {
        id: id.into(),
        kind,
        title,
        commit_subject: None,
        base_ref,
        head_ref,
        patches_deferred: (deferred && diff.files.is_some()).then_some(true),
        files: diff
            .files
            .as_ref()
            .map(|f| f.iter().map(FileStat::to_contract).collect()),
        diff_hash: hash,
        truncated: diff.truncated,
        diff: diff.diff,
    }
}

fn empty_preview(cwd: &str) -> ReviewDiffPreviewResult {
    ReviewDiffPreviewResult {
        cwd: cwd.to_owned(),
        generated_at: clock::now_iso(),
        sources: Vec::new(),
        incomplete: None,
    }
}

pub async fn diff_preview(input: ReviewDiffPreviewInput) -> VcsResult<ReviewDiffPreviewResult> {
    Box::pin(diff_preview_inner(input)).await
}

async fn diff_preview_inner(input: ReviewDiffPreviewInput) -> VcsResult<ReviewDiffPreviewResult> {
    let requested = PathBuf::from(&input.cwd);
    let file = input.file.as_ref();
    let mut paths = Vec::new();
    if let Some(file) = file {
        paths.push(literal_pathspec(&file.path));
        if let Some(previous) = &file.previous_path {
            paths.push(literal_pathspec(previous));
        }
    }
    let patch_limit = if file.is_some() {
        FILE_MAX_BYTES
    } else {
        PATCH_MAX_BYTES
    };
    let Some(root) = repo::toplevel(&requested).await? else {
        return Ok(empty_preview(&input.cwd));
    };
    let cwd = root.as_path();
    let ignore_whitespace = input.ignore_whitespace == Some(true);
    let metadata_requested = input.metadata_only == Some(true);

    let is_commit = input.commit_sha.is_some()
        || file.is_some_and(|f| f.source_kind == ReviewDiffPreviewSourceKind::Commit);
    if is_commit {
        return commit_preview(&input, cwd, &paths, patch_limit, ignore_whitespace).await;
    }

    let source_kind = match file.map(|f| f.source_kind) {
        Some(ReviewDiffPreviewSourceKind::WorkingTree) => {
            Some(ReviewDiffPreviewInputSourceKind::WorkingTree)
        }
        Some(ReviewDiffPreviewSourceKind::BranchRange) => {
            Some(ReviewDiffPreviewInputSourceKind::BranchRange)
        }
        _ => input.source_kind,
    };
    let branch = if source_kind == Some(ReviewDiffPreviewInputSourceKind::WorkingTree) {
        None
    } else {
        repo::current_branch(cwd).await?
    };
    let review = if source_kind == Some(ReviewDiffPreviewInputSourceKind::WorkingTree) {
        repo::MergeBase {
            base_ref: input.base_ref.clone(),
            merge_base: String::new(),
        }
    } else {
        repo::merge_base(cwd, branch.as_deref(), input.base_ref.as_deref()).await?
    };
    let merge_base = (!review.merge_base.is_empty()).then_some(review.merge_base.as_str());
    let dirty_ref = if source_kind == Some(ReviewDiffPreviewInputSourceKind::BranchRange) {
        None
    } else {
        Some("HEAD")
    };

    let untracked = if input.tracked_only == Some(true) {
        Untracked::None
    } else {
        prepare_untracked(cwd, &paths, file.map(|f| f.path.as_str()), None).await?
    };
    let unavailable = matches!(untracked, Untracked::Unavailable);
    let metadata_only = metadata_requested && file.is_none() && !unavailable;
    let mut diff_args: Vec<String> = DIFF_ARGS.iter().map(|s| (*s).to_owned()).collect();
    diff_args.push("--minimal".into());
    if ignore_whitespace {
        diff_args.push("--ignore-all-space".into());
    }
    let request = DiffRequest {
        cwd,
        diff_args,
        paths: &paths,
        patch_limit,
        index: untracked.index(),
    };
    let (mut dirty, mut base) = if merge_base == dirty_ref {
        let dirty = request.read(dirty_ref, metadata_only).await?;
        let base = TrackedDiff {
            diff: dirty.diff.clone(),
            truncated: dirty.truncated,
            files: dirty.files.clone(),
        };
        (dirty, base)
    } else {
        tokio::try_join!(
            request.read(dirty_ref, metadata_only),
            request.read(merge_base, metadata_only)
        )?
    };
    drop(untracked);
    if unavailable {
        for (diff, reference) in [(&mut dirty, dirty_ref), (&mut base, merge_base)] {
            if reference.is_some() {
                diff.files = None;
                diff.truncated = true;
            }
        }
    }

    let deferred = metadata_requested && file.is_none();
    let title = match &review.base_ref {
        Some(base_ref) => format!("Changes vs {base_ref}"),
        None => "Changes".into(),
    };
    let mut sources = vec![
        source(
            "working-tree",
            ReviewDiffPreviewSourceKind::WorkingTree,
            "Uncommitted".into(),
            Some("HEAD".into()),
            None,
            dirty,
            deferred,
        ),
        source(
            "branch-range",
            ReviewDiffPreviewSourceKind::BranchRange,
            title,
            review.base_ref.clone(),
            Some(branch.unwrap_or_else(|| "HEAD".into())),
            base,
            deferred,
        ),
    ];
    if let Some(kind) = input.source_kind {
        let wanted = match kind {
            ReviewDiffPreviewInputSourceKind::WorkingTree => {
                ReviewDiffPreviewSourceKind::WorkingTree
            }
            ReviewDiffPreviewInputSourceKind::BranchRange => {
                ReviewDiffPreviewSourceKind::BranchRange
            }
        };
        sources.retain(|s| s.kind == wanted);
    }
    Ok(ReviewDiffPreviewResult {
        cwd: input.cwd,
        generated_at: clock::now_iso(),
        sources,
        incomplete: (input.tracked_only == Some(true)).then_some(true),
    })
}

struct Commit {
    sha: String,
    parent: String,
}

fn invalid_commit(cwd: &Path, detail: &str) -> VcsError {
    VcsError::invalid("GitVcsDriver.reviewCommit", &cwd.to_string_lossy(), detail)
}

fn is_object_id(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

async fn commit_exists(cwd: &Path, sha: &str) -> VcsResult<bool> {
    repo::succeeds(
        git(
            "GitVcsDriver.reviewCommit",
            cwd,
            [
                "cat-file".to_owned(),
                "-e".into(),
                format!("{sha}^{{commit}}"),
            ],
        )
        .env("GIT_NO_LAZY_FETCH", "1"),
    )
    .await
}

async fn resolve_commit(cwd: &Path, sha: &str) -> VcsResult<Commit> {
    const GONE: &str = "Selected commit is invalid or no longer available.";
    if !is_object_id(sha) || !commit_exists(cwd, sha).await? {
        return Err(invalid_commit(cwd, GONE));
    }
    let object = git(
        "GitVcsDriver.reviewCommit",
        cwd,
        ["cat-file", "commit", sha],
    )
    .text()
    .await?;
    let parent = object
        .lines()
        .nth(1)
        .and_then(|l| l.strip_prefix("parent "))
        .map(str::to_owned);
    let parent = match parent {
        Some(parent) => {
            if !commit_exists(cwd, &parent).await? {
                return Err(invalid_commit(
                    cwd,
                    "Selected commit's parent is not available locally.",
                ));
            }
            parent
        }
        None => repo::empty_tree(cwd).await?,
    };
    Ok(Commit {
        sha: sha.to_ascii_lowercase(),
        parent,
    })
}

async fn commit_preview(
    input: &ReviewDiffPreviewInput,
    cwd: &Path,
    paths: &[String],
    patch_limit: usize,
    ignore_whitespace: bool,
) -> VcsResult<ReviewDiffPreviewResult> {
    let sha = match (&input.commit_sha, &input.file) {
        (Some(sha), None) => sha,
        (Some(sha), Some(f)) if f.source_kind == ReviewDiffPreviewSourceKind::Commit => sha,
        _ => return Err(invalid_commit(cwd, "Selected commit request is invalid.")),
    };
    let commit = resolve_commit(cwd, sha).await?;
    let message = git(
        "GitVcsDriver.reviewCommit",
        cwd,
        [
            "show",
            "-s",
            "--no-notes",
            "--no-show-signature",
            "--format=%B",
            commit.sha.as_str(),
        ],
    )
    .max_stdout(8192, OnLimit::Truncate)
    .run()
    .await?
    .stdout_text();
    let subject: String = message
        .split('\n')
        .next()
        .unwrap_or_default()
        .chars()
        .take(SUBJECT_LIMIT)
        .collect();
    let mut diff_args: Vec<String> = DIFF_ARGS.iter().map(|s| (*s).to_owned()).collect();
    if ignore_whitespace {
        diff_args.push("--ignore-all-space".into());
    }
    let request = DiffRequest {
        cwd,
        diff_args,
        paths,
        patch_limit,
        index: None,
    };
    let refs = [commit.parent.as_str(), commit.sha.as_str()];
    let stat = request
        .command(
            "GitVcsDriver.getReviewDiffPreview.stat",
            &["--numstat", "-z"],
            &refs,
        )
        .max_stdout(METADATA_MAX_BYTES, OnLimit::Fail)
        .text()
        .await?;
    let files = parse_numstat(&stat);
    let deferred = input.metadata_only == Some(true) && input.file.is_none();
    let (diff, truncated) = if deferred {
        (String::new(), false)
    } else {
        let patch = request
            .command(
                "GitVcsDriver.getReviewDiffPreview.patch",
                &["--patch"],
                &refs,
            )
            .max_stdout(patch_limit, OnLimit::Truncate)
            .run()
            .await?;
        (patch.stdout_text(), patch.stdout_truncated)
    };
    let short: String = commit.sha.chars().take(7).collect();
    let mut source = source(
        &commit.sha,
        ReviewDiffPreviewSourceKind::Commit,
        format!("Commit {short}"),
        Some(commit.parent.clone()),
        Some(commit.sha.clone()),
        TrackedDiff {
            diff,
            truncated,
            files: Some(files),
        },
        deferred,
    );
    let subject = subject.trim();
    if !subject.is_empty() {
        source.commit_subject = Some(subject.to_owned());
    }
    Ok(ReviewDiffPreviewResult {
        cwd: input.cwd.clone(),
        generated_at: clock::now_iso(),
        sources: vec![source],
        incomplete: None,
    })
}

const CONTENTS_OP: &str = "GitVcsDriver.getReviewDiffFileContents";

/// `is_internal` names the server's own files (`conn_files::paths::InternalPaths`); a
/// working-tree file that resolves into them is refused, as `GitVcsDriverCore.ts` does.
pub async fn diff_file_contents(
    input: ReviewDiffFileContentsInput,
    is_internal: impl Fn(&Path) -> bool + Send + 'static,
) -> VcsResult<ReviewDiffFileContentsResult> {
    let cwd = PathBuf::from(&input.cwd);
    let root = repo::optional_text(
        git(CONTENTS_OP, &cwd, ["rev-parse", "--show-toplevel"]).timeout(PROBE_TIMEOUT),
    )
    .await?
    .filter(|r| !r.is_empty())
    .ok_or_else(|| {
        VcsError::invalid(
            CONTENTS_OP,
            &input.cwd,
            "Could not resolve the Git repository root.",
        )
    })?;
    let root = PathBuf::from(root);
    let (old_revision, new_revision) = match input.source_kind {
        ReviewDiffPreviewSourceKind::Commit => {
            let Some(head) = input.head_ref.as_deref() else {
                return Err(VcsError::invalid(
                    CONTENTS_OP,
                    &input.cwd,
                    "Selected commit is no longer available.",
                ));
            };
            let commit = resolve_commit(&cwd, head).await?;
            if input.base_ref.as_deref() != Some(commit.parent.as_str()) {
                return Err(VcsError::invalid(
                    CONTENTS_OP,
                    &input.cwd,
                    "Selected commit changed. Refresh the comparison.",
                ));
            }
            (commit.parent, Some(commit.sha))
        }
        ReviewDiffPreviewSourceKind::WorkingTree => (
            input.base_ref.clone().unwrap_or_else(|| "HEAD".into()),
            None,
        ),
        ReviewDiffPreviewSourceKind::BranchRange => (
            repo::merge_base(&cwd, None, input.base_ref.as_deref())
                .await?
                .merge_base,
            None,
        ),
    };
    let old_contents = if input.change_type == ChangeType::New {
        String::new()
    } else {
        show_file(&cwd, &old_revision, &input.old_path).await?
    };
    let new_contents = match (input.change_type, new_revision) {
        (ChangeType::Deleted, _) => String::new(),
        (_, Some(revision)) => show_file(&cwd, &revision, &input.new_path).await?,
        (_, None) => {
            read_working_file(&input.cwd, root, input.new_path.clone(), is_internal).await?
        }
    };
    Ok(ReviewDiffFileContentsResult {
        old_contents,
        new_contents,
    })
}

async fn show_file(cwd: &Path, revision: &str, path: &str) -> VcsResult<String> {
    let out = git(
        "GitVcsDriver.getReviewDiffFileContents.revision",
        cwd,
        [
            "show".to_owned(),
            "--end-of-options".into(),
            format!("{revision}:{path}"),
        ],
    )
    .max_stdout(FILE_MAX_BYTES, OnLimit::Fail)
    .run()
    .await?;
    if out.stdout.contains(&0) {
        return Err(VcsError::invalid(
            CONTENTS_OP,
            &cwd.to_string_lossy(),
            format!("Cannot expand binary file '{path}'."),
        ));
    }
    Ok(out.stdout_text())
}

async fn read_working_file(
    cwd: &str,
    root: PathBuf,
    path: String,
    is_internal: impl Fn(&Path) -> bool + Send + 'static,
) -> VcsResult<String> {
    let cwd = cwd.to_owned();
    tokio::task::spawn_blocking(move || {
        let fail =
            |operation: &'static str, detail: String| VcsError::invalid(operation, &cwd, detail);
        let outside = format!("Diff file '{path}' resolves outside the review workspace.");
        let requested = root.join(&path);
        if !normalize(&requested).starts_with(normalize(&root)) {
            return Err(fail(
                "GitVcsDriver.getReviewDiffFileContents.workingTree.path.resolve",
                outside,
            ));
        }
        let unresolved = || format!("Could not resolve diff file '{path}'.");
        let real_root = std::fs::canonicalize(&root).map_err(|_| {
            fail(
                "GitVcsDriver.getReviewDiffFileContents.workingTree.fs.realPath",
                unresolved(),
            )
        })?;
        let real = std::fs::canonicalize(&requested).map_err(|_| {
            fail(
                "GitVcsDriver.getReviewDiffFileContents.workingTree.fs.realPath",
                unresolved(),
            )
        })?;
        if !real.starts_with(&real_root) {
            return Err(fail(
                "GitVcsDriver.getReviewDiffFileContents.workingTree.fs.realPath",
                outside,
            ));
        }
        if is_internal(&real) {
            return Err(fail(
                "GitVcsDriver.getReviewDiffFileContents.workingTree.fs.realPath",
                format!("Diff file '{path}' is not available."),
            ));
        }
        let meta = std::fs::metadata(&real).map_err(|_| {
            fail(
                "GitVcsDriver.getReviewDiffFileContents.workingTree.fs.stat",
                format!("Could not inspect diff file '{path}'."),
            )
        })?;
        if !meta.is_file() {
            return Err(fail(
                "fs.stat",
                format!("Diff path '{path}' is not a file."),
            ));
        }
        if meta.len() > FILE_MAX_BYTES as u64 {
            return Err(fail(
                "fs.stat",
                format!("Diff file '{path}' exceeds the 1 MB expansion limit."),
            ));
        }
        let bytes = std::fs::read(&real).map_err(|_| {
            fail(
                "GitVcsDriver.getReviewDiffFileContents.workingTree.fs.readFile",
                format!("Could not read diff file '{path}'."),
            )
        })?;
        if bytes.contains(&0) {
            return Err(fail(
                "fs.readFile",
                format!("Cannot expand binary file '{path}'."),
            ));
        }
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })
    .await
    .map_err(|e| VcsError::invalid(CONTENTS_OP, "", e.to_string()))?
}

/// Lexically resolves `.` and `..` without touching the disk.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

pub async fn branch_commits(
    input: ReviewBranchCommitsInput,
) -> VcsResult<ReviewBranchCommitsResult> {
    let empty = ReviewBranchCommitsResult {
        commits: Vec::new(),
        truncated: false,
    };
    let requested = PathBuf::from(&input.cwd);
    let Some(root) = repo::toplevel(&requested).await? else {
        return Ok(empty);
    };
    let cwd = root.as_path();
    match git(
        "GitVcsDriver.reviewCommit",
        cwd,
        ["rev-parse", "--verify", "--quiet", "HEAD"],
    )
    .run()
    .await
    {
        Ok(_) => {}
        Err(ProcessError::Exit {
            code: 1, stderr, ..
        }) if stderr.trim().is_empty() => return Ok(empty),
        Err(_) => {
            return Err(invalid_commit(
                cwd,
                "Could not resolve the current branch commit.",
            ));
        }
    }
    let branch = repo::current_branch(cwd).await?;
    let review = repo::merge_base(cwd, branch.as_deref(), input.base_ref.as_deref()).await?;
    let out = git(
        "GitVcsDriver.reviewCommit",
        cwd,
        [
            "log".to_owned(),
            "-z".into(),
            "--no-notes".into(),
            "--no-show-signature".into(),
            "--format=%H%x00%s%x00%cI".into(),
            format!("--max-count={}", BRANCH_COMMIT_LIMIT + 1),
            format!("{}..HEAD", review.merge_base),
        ],
    )
    .max_stdout(BRANCH_COMMIT_MAX_BYTES, OnLimit::Truncate)
    .run()
    .await?;
    let text = out.stdout_text();
    let unreadable = || invalid_commit(cwd, "Could not read branch commit metadata.");
    if !out.stdout_truncated && !text.is_empty() && !text.ends_with('\0') {
        return Err(unreadable());
    }
    // Records are `sha NUL subject NUL date NUL`; a cut-off last record is dropped.
    let fields: Vec<&str> = text.split('\0').collect();
    let complete = fields.len().saturating_sub(1);
    let mut commits = Vec::new();
    let (records, _) = fields.get(..complete).unwrap_or_default().as_chunks::<3>();
    for [sha, subject, committed_at] in records.iter().take(BRANCH_COMMIT_LIMIT + 1) {
        // `git log -z` separates records with NUL too, so a record may start with a newline.
        let sha = sha.trim_start_matches('\n');
        if !is_object_id(sha) || committed_at.is_empty() {
            return Err(unreadable());
        }
        commits.push(ReviewBranchCommitsResultCommitsItem {
            sha: sha.to_owned(),
            subject: subject.chars().take(SUBJECT_LIMIT).collect(),
            committed_at: (*committed_at).to_owned(),
        });
    }
    if out.stdout_truncated && commits.is_empty() {
        return Err(invalid_commit(
            cwd,
            "Branch commit metadata exceeds the response limit.",
        ));
    }
    let truncated = out.stdout_truncated || commits.len() > BRANCH_COMMIT_LIMIT;
    commits.truncate(BRANCH_COMMIT_LIMIT);
    Ok(ReviewBranchCommitsResult { commits, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numstat_parses_renames_and_binaries() {
        let out = "3\t1\tsrc/a.rs\0-\t-\timg.png\0\
                   2\t0\t\0old/name.rs\0new/name.rs\0";
        let files = parse_numstat(out);
        assert_eq!(
            files,
            vec![
                FileStat {
                    path: "src/a.rs".into(),
                    previous_path: None,
                    additions: 3,
                    deletions: 1
                },
                FileStat {
                    path: "img.png".into(),
                    previous_path: None,
                    additions: 0,
                    deletions: 0
                },
                FileStat {
                    path: "new/name.rs".into(),
                    previous_path: Some("old/name.rs".into()),
                    additions: 2,
                    deletions: 0
                },
            ]
        );
    }

    #[test]
    fn diff_hash_matches_json_stringify() {
        // node -e 'console.log(require("crypto").createHash("sha256").update(JSON.stringify(["d\n",[{path:"a",previousPath:null,additions:1,deletions:0}]])).digest("hex"))'
        let files = [FileStat {
            path: "a".into(),
            previous_path: None,
            additions: 1,
            deletions: 0,
        }];
        assert_eq!(
            serde_json::to_string(&("d\n", &files[..])).unwrap(),
            r#"["d\n",[{"path":"a","previousPath":null,"additions":1,"deletions":0}]]"#
        );
        assert_eq!(diff_hash("d\n", &files).len(), 64);
    }
}
