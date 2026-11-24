//! Turn checkpoints in git, as the T3 server stores them (`GitVcsDriver.ts` `checkpoints`,
//! `CheckpointService.ts`, `checkpointing/Diffs.ts`).
//!
//! A checkpoint is a commit of the whole working tree (tracked and untracked files, not ignored
//! ones) under `refs/t3/orchestration-v2/checkpoints/<scope key>/ordinal/<n>` in the workspace's
//! own repository. The commit's first parent is `HEAD` (none on an unborn branch), its author
//! and committer are "T3 Code", its message is `t3 checkpoint ref=<ref>`. It is built in a
//! scratch index next to the repository's (`<common dir>/t3-checkpoint-index-<uuid>`), so the
//! user's index and working tree are never touched. Git stores the objects; an unchanged tree
//! reuses every blob and tree, and costs one commit object.
//!
//! Not ported (each is a T3 refinement for a rare repository shape): the second parent for a
//! turn that switched branches (`T3-Head-Moved-At`), re-adding hand-flagged index entries
//! (we rebuild the scratch index from `HEAD` instead, which reads every file once), sparse
//! checkouts (a capture there reports [`Captured::Unsupported`]), a workspace folder that its
//! repository ignores, and the retry that excludes uncommitted embedded repositories.

use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use sha2::{Digest, Sha256};

use crate::{
    VcsError, VcsResult,
    process::{GitCommand, OnLimit, ProcessError},
};

/// `CHECKPOINT_REFS_PREFIX` in `CheckpointService.ts`.
pub const REFS_PREFIX: &str = "refs/t3/orchestration-v2/checkpoints";
/// `CHECKPOINT_DIFF_MAX_OUTPUT_BYTES` in `VcsDriver.ts`.
pub const DIFF_MAX_OUTPUT_BYTES: usize = 10_000_000;
/// `CHECKPOINT_DIFF_TRUNCATED_MARKER` in `contracts/checkpointDiff.ts`.
pub const TRUNCATED_MARKER: &str = "\n\n[truncated]";
/// A whole-tree `add -A` on a large repository takes longer than a status read.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(120);
const AUTHOR: &str = "T3 Code";
const EMAIL: &str = "t3code@users.noreply.github.com";
/// `REF_MOVE_REFLOG_SUBJECT`: reflog subjects that move a ref without making a commit.
fn is_ref_move(subject: &str) -> bool {
    let lower = subject.to_ascii_lowercase();
    if lower.is_empty() {
        return true;
    }
    let word = |w: &str| {
        lower.starts_with(w)
            && lower
                .as_bytes()
                .get(w.len())
                .is_none_or(|b| !b.is_ascii_alphanumeric() && *b != b'_')
    };
    if ["checkout", "reset", "branch", "clone", "fetch"]
        .iter()
        .any(|w| word(w))
    {
        return true;
    }
    // `[^:]*\((?:start|finish|abort|reset)\): `
    if let Some(colon) = lower.find(':')
        && lower
            .get(colon..)
            .is_some_and(|rest| rest.starts_with(": "))
        && let Some(head) = lower.get(..colon)
        && ["(start)", "(finish)", "(abort)", "(reset)"]
            .iter()
            .any(|tag| head.ends_with(tag))
    {
        return true;
    }
    ["merge", "pull", "rebase", "cherry-pick"]
        .iter()
        .any(|w| word(w))
        && lower.ends_with(": fast-forward")
        && !lower.contains('(')
        && !lower.contains(')')
}

/// The ref of checkpoint `ordinal` in scope `scope_id` (`checkpointRefForScopeOrdinal`): the
/// first 32 hex digits of the scope id's SHA-256, base64url without padding.
pub fn checkpoint_ref(scope_id: &str, ordinal: u64) -> String {
    let digest = Sha256::digest(scope_id.as_bytes());
    let hex = conn_support::hex::hex(&digest);
    let key = hex.get(..32).unwrap_or(&hex);
    format!(
        "{REFS_PREFIX}/{}/ordinal/{ordinal}",
        conn_support::base64::url_encode(key.as_bytes())
    )
}

/// What a capture did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Captured {
    Ready,
    /// The repository shape is one this server does not snapshot (T3's
    /// `VcsUnsupportedOperationError`); the checkpoint is `missing`.
    Unsupported,
}

/// `numstat` or `patch`, as `diffCheckpoints` takes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiffFormat {
    Patch,
    Numstat,
}

/// One input of [`diff`].
#[derive(Clone, Debug)]
pub struct DiffRequest<'a> {
    pub cwd: &'a Path,
    pub from_ref: &'a str,
    pub to_ref: &'a str,
    pub ignore_whitespace: bool,
    pub format: DiffFormat,
    /// Bytes kept of the patch; a numstat over it fails.
    pub max_output_bytes: usize,
    /// Limits the diff to these repository-relative paths. Empty: an empty diff.
    pub file_paths: Option<Vec<String>>,
}

/// A file of a numstat (`TurnDiffFileSummary`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileSummary {
    pub path: String,
    pub previous_path: Option<String>,
    pub additions: u64,
    pub deletions: u64,
}

fn durable_write() -> Vec<&'static str> {
    let mut args = vec![
        "-c",
        "core.fsync=objects,reference",
        "-c",
        "core.fsyncMethod=fsync",
    ];
    if cfg!(any(target_os = "macos", target_os = "windows")) {
        args.extend(["-c", "core.fsyncMethod=batch"]);
    }
    args
}

const INDEX_CONFIG: [&str; 8] = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "sparse.expectFilesOutsideOfPatterns=false",
    "-c",
    "core.splitIndex=false",
    "-c",
    "splitIndex.sharedIndexExpire=never",
];

fn git<I, S>(operation: &'static str, cwd: &Path, args: I) -> GitCommand
where
    I: IntoIterator<Item = S>,
    S: Into<std::ffi::OsString>,
{
    GitCommand::new(operation, cwd, args)
}

fn has_error_line(stderr: &str) -> bool {
    stderr
        .lines()
        .any(|line| line.starts_with("error:") || line.starts_with("fatal:"))
}

/// True when `cwd` is inside a git work tree. A failed probe is an error, not "no"; a missing
/// folder is "no", as T3's work-tree probe reads it.
pub async fn is_repository(cwd: &Path) -> VcsResult<bool> {
    if !crate::repo::is_dir(cwd).await {
        return Ok(false);
    }
    let out = git(
        "CheckpointStore.isGitRepository",
        cwd,
        ["rev-parse", "--is-inside-work-tree"],
    )
    .allow_exit(&[128])
    .run()
    .await?;
    if out.code == 128 {
        // Line starts only: a path inside another diagnostic can hold the same words.
        if out.stderr.lines().any(|line| {
            line.starts_with("fatal: not a git repository")
                || line.starts_with("fatal: cannot use bare repository")
        }) {
            return Ok(false);
        }
        return Err(VcsError::invalid(
            "CheckpointStore.isGitRepository",
            &cwd.to_string_lossy(),
            out.stderr.trim().to_owned(),
        ));
    }
    Ok(out.stdout_text().trim() == "true")
}

/// The commit a ref names, `None` when the ref does not exist.
async fn resolve_commit(cwd: &Path, reference: &str) -> VcsResult<Option<String>> {
    let out = git(
        "GitVcsDriver.checkpoints.resolveCheckpointCommit",
        cwd,
        [
            "rev-parse".to_owned(),
            "--verify".into(),
            "--quiet".into(),
            format!("{reference}^{{commit}}"),
        ],
    )
    .allow_exit(&[1])
    .run()
    .await?;
    if out.code == 1 {
        if has_error_line(&out.stderr) {
            return Err(VcsError::invalid(
                "GitVcsDriver.checkpoints.resolveCheckpointCommit",
                &cwd.to_string_lossy(),
                out.stderr.trim().to_owned(),
            ));
        }
        return Ok(None);
    }
    let commit = out.stdout_text().trim().to_owned();
    Ok((!commit.is_empty()).then_some(commit))
}

pub async fn has_ref(cwd: &Path, reference: &str) -> VcsResult<bool> {
    Ok(resolve_commit(cwd, reference).await?.is_some())
}

struct CaptureRepo {
    common_dir: PathBuf,
    index_path: PathBuf,
    head: Option<String>,
}

async fn capture_repository(cwd: &Path) -> VcsResult<CaptureRepo> {
    const OP: &str = "GitVcsDriver.checkpoints.captureCheckpoint";
    let out = git(
        OP,
        cwd,
        [
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
            "--git-path",
            "index",
            "--show-prefix",
            "--verify",
            "--quiet",
            "HEAD",
        ],
    )
    .allow_exit(&[1])
    .run()
    .await?;
    let text = out.stdout_text();
    let lines: Vec<&str> = text.split('\n').collect();
    let head_exists = out.code == 0;
    let expected = if head_exists { 5 } else { 4 };
    if lines.len() != expected || lines.last() != Some(&"") {
        return Err(VcsError::invalid(
            OP,
            &cwd.to_string_lossy(),
            "git rev-parse gave paths this server cannot read (git before 2.31, or a newline in a path)",
        ));
    }
    let line = |i: usize| lines.get(i).copied().unwrap_or_default();
    Ok(CaptureRepo {
        common_dir: PathBuf::from(line(0).trim()),
        index_path: PathBuf::from(line(1).trim()),
        head: head_exists.then(|| line(3).trim().to_owned()),
    })
}

/// Copies the user's index to the scratch index and gives it a time just before the source's,
/// which keeps git's racy-entry check. `false` when the index cannot be used.
async fn copy_index(from: PathBuf, to: PathBuf) -> Option<SystemTime> {
    tokio::task::spawn_blocking(move || {
        let modified = std::fs::metadata(&from).ok()?.modified().ok()?;
        let since = modified.duration_since(SystemTime::UNIX_EPOCH).ok()?;
        let seconds = (since.as_millis().checked_sub(1)? / 1000) as u64;
        if seconds == 0 {
            return None;
        }
        std::fs::copy(&from, &to).ok()?;
        Some(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds))
    })
    .await
    .ok()
    .flatten()
}

async fn set_mtime(path: PathBuf, time: SystemTime) -> bool {
    tokio::task::spawn_blocking(move || {
        let file = std::fs::OpenOptions::new().write(true).open(&path).ok()?;
        file.set_times(
            std::fs::FileTimes::new()
                .set_modified(time)
                .set_accessed(time),
        )
        .ok()
    })
    .await
    .ok()
    .flatten()
    .is_some()
}

async fn remove_files(paths: Vec<PathBuf>) {
    let _ = tokio::task::spawn_blocking(move || {
        for path in paths {
            let _ = std::fs::remove_file(path);
        }
    })
    .await;
}

/// Index entries flagged by hand (`assume-unchanged`, `skip-worktree`) hide edits from
/// `add -A`. Reads `ls-files -v` one chunk at a time.
async fn has_flagged_entries(cwd: &Path, index: &Path) -> VcsResult<bool> {
    let mut args: Vec<&str> = INDEX_CONFIG.to_vec();
    args.extend(["ls-files", "--full-name", "--stage", "-v", "-z"]);
    let mut record_start = true;
    let mut flagged = false;
    git("GitVcsDriver.checkpoints.captureCheckpoint", cwd, args)
        .env("GIT_INDEX_FILE", index)
        .timeout(CAPTURE_TIMEOUT)
        .scan(&mut |chunk: &[u8]| {
            for byte in chunk {
                if record_start && (byte.is_ascii_lowercase() || *byte == b'S') {
                    flagged = true;
                }
                record_start = *byte == 0;
            }
        })
        .await?;
    Ok(flagged)
}

/// Captures the working tree of `cwd` under `reference` (`captureCheckpoint`).
pub async fn capture(cwd: &Path, reference: &str) -> VcsResult<Captured> {
    const OP: &str = "GitVcsDriver.checkpoints.captureCheckpoint";
    let repo = capture_repository(cwd).await?;
    let sparse = git(OP, cwd, ["config", "--bool", "core.sparseCheckout"])
        .allow_exit(&[1])
        .text()
        .await
        .unwrap_or_default();
    if sparse.trim() == "true" {
        return Ok(Captured::Unsupported);
    }
    let temp = repo
        .common_dir
        .join(format!("t3-checkpoint-index-{}", conn_support::uuid_v4()));
    let mut lock = temp.clone().into_os_string();
    lock.push(".lock");
    let cleanup = vec![temp.clone(), PathBuf::from(lock)];
    let result = capture_with_index(cwd, reference, &repo, &temp).await;
    remove_files(cleanup).await;
    result.map(|()| Captured::Ready)
}

async fn capture_with_index(
    cwd: &Path,
    reference: &str,
    repo: &CaptureRepo,
    temp: &Path,
) -> VcsResult<()> {
    const OP: &str = "GitVcsDriver.checkpoints.captureCheckpoint";
    let with_index = |args: Vec<&str>| {
        let mut all: Vec<&str> = INDEX_CONFIG.to_vec();
        all.extend(args);
        git(OP, cwd, all)
            .env("GIT_INDEX_FILE", temp)
            .env("GIT_AUTHOR_NAME", AUTHOR)
            .env("GIT_AUTHOR_EMAIL", EMAIL)
            .env("GIT_COMMITTER_NAME", AUTHOR)
            .env("GIT_COMMITTER_EMAIL", EMAIL)
            .timeout(CAPTURE_TIMEOUT)
    };
    if repo.head.is_some() {
        // The user's index keeps its stat cache, so unchanged files are not read again.
        let mut reused = false;
        if let Some(time) = copy_index(repo.index_path.clone(), temp.to_owned()).await
            && with_index(vec!["read-tree", "--reset", "HEAD"])
                .run()
                .await
                .is_ok()
            && set_mtime(temp.to_owned(), time).await
        {
            reused = !has_flagged_entries(cwd, temp).await.unwrap_or(true);
        }
        if !reused {
            let mut lock = temp.as_os_str().to_owned();
            lock.push(".lock");
            remove_files(vec![temp.to_owned(), PathBuf::from(lock)]).await;
            with_index(vec!["read-tree", "HEAD"]).run().await?;
        }
    }
    let mut add = durable_write();
    add.extend(["-c", "core.safecrlf=false", "add", "-A", "--", "."]);
    with_index(add).run().await?;
    let mut write_tree = durable_write();
    write_tree.push("write-tree");
    let tree = with_index(write_tree).text().await?.trim().to_owned();
    if tree.is_empty() {
        return Err(VcsError::invalid(
            OP,
            &cwd.to_string_lossy(),
            "git write-tree returned an empty tree oid.",
        ));
    }
    let message = format!("t3 checkpoint ref={reference}");
    let mut commit_args: Vec<String> = durable_write().into_iter().map(str::to_owned).collect();
    commit_args.extend(["commit-tree".to_owned(), tree]);
    if let Some(head) = &repo.head {
        commit_args.extend(["-p".to_owned(), head.clone()]);
    }
    commit_args.extend(["-m".to_owned(), message]);
    let commit = git(OP, cwd, commit_args)
        .env("GIT_INDEX_FILE", temp)
        .env("GIT_AUTHOR_NAME", AUTHOR)
        .env("GIT_AUTHOR_EMAIL", EMAIL)
        .env("GIT_COMMITTER_NAME", AUTHOR)
        .env("GIT_COMMITTER_EMAIL", EMAIL)
        .text()
        .await?
        .trim()
        .to_owned();
    if commit.is_empty() {
        return Err(VcsError::invalid(
            OP,
            &cwd.to_string_lossy(),
            "git commit-tree returned an empty commit oid.",
        ));
    }
    let mut update: Vec<String> = durable_write().into_iter().map(str::to_owned).collect();
    update.extend(["update-ref".to_owned(), reference.to_owned(), commit]);
    git(OP, cwd, update).run().await?;
    Ok(())
}

/// Puts the working tree of `cwd` back to `reference` (`restoreCheckpoint`): tracked files
/// as in the checkpoint, untracked files that the checkpoint does not have removed, the index
/// reset to `HEAD`. `false` when the ref does not exist.
pub async fn restore(cwd: &Path, reference: &str) -> VcsResult<bool> {
    const OP: &str = "GitVcsDriver.checkpoints.restoreCheckpoint";
    let cwd_text = cwd.to_string_lossy().into_owned();
    let Some(commit) = resolve_commit(cwd, reference).await? else {
        return Ok(false);
    };
    let tracked = git(
        OP,
        cwd,
        [
            "ls-files".to_owned(),
            "--cached".into(),
            format!("--with-tree={commit}"),
            "-z".into(),
            "--".into(),
            ".".into(),
        ],
    )
    .max_stdout(1, OnLimit::Truncate)
    .run()
    .await?;
    if !tracked.stdout.is_empty() {
        git(
            OP,
            cwd,
            [
                "restore",
                "--source",
                &commit,
                "--worktree",
                "--staged",
                "--ignore-skip-worktree-bits",
                "--",
                ".",
            ],
        )
        .timeout(CAPTURE_TIMEOUT)
        .run()
        .await?;
    }
    let recreate = || async {
        let dir = cwd.to_owned();
        tokio::task::spawn_blocking(move || std::fs::create_dir_all(dir))
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r.map_err(|e| e.to_string()))
            .map_err(|e| {
                VcsError::invalid(
                    OP,
                    &cwd_text,
                    format!("Could not recreate the checkpoint workspace: {e}"),
                )
            })
    };
    let reset_index = || async {
        recreate().await?;
        git(OP, cwd, ["reset", "--quiet", "--", "."])
            .run()
            .await
            .map(|_| ())
            .map_err(VcsError::from)
    };
    let clean = || {
        git(OP, cwd, ["clean", "-fd", "--", "."])
            .allow_exit(&[1])
            .timeout(CAPTURE_TIMEOUT)
            .run()
    };
    let removed = |stdout: &[u8]| {
        String::from_utf8_lossy(stdout)
            .lines()
            .any(|l| l.starts_with("Removing "))
    };
    recreate().await?;
    let mut cleaned = clean().await?;
    // Removing a new .gitignore shows the files it hid: clean again, at most 4 passes.
    let mut pass = 1;
    while pass < 4 && cleaned.code == 0 && removed(&cleaned.stdout) {
        recreate().await?;
        cleaned = clean().await?;
        pass += 1;
    }
    if cleaned.code == 0 && removed(&cleaned.stdout) {
        recreate().await?;
        let remaining = git(OP, cwd, ["clean", "-dn", "--", "."]).run().await?;
        if String::from_utf8_lossy(&remaining.stdout)
            .lines()
            .any(|l| l.starts_with("Would remove "))
        {
            reset_index().await?;
            return Err(VcsError::invalid(
                OP,
                &cwd_text,
                "Could not clean the checkpoint workspace: untracked files remain.",
            ));
        }
    }
    if cleaned.code != 0 {
        let stderr = cleaned.stderr.trim();
        let emptied = cleaned.code == 1
            && stderr.starts_with("warning: failed to remove ./: ")
            && !stderr.contains('\n')
            && dir_is_empty(cwd.to_owned()).await;
        if !emptied {
            reset_index().await?;
            return Err(VcsError::invalid(
                OP,
                &cwd_text,
                if stderr.is_empty() {
                    "Could not clean the checkpoint workspace.".to_owned()
                } else {
                    stderr.to_owned()
                },
            ));
        }
    }
    reset_index().await?;
    Ok(true)
}

async fn dir_is_empty(dir: PathBuf) -> bool {
    tokio::task::spawn_blocking(move || {
        std::fs::read_dir(dir).is_ok_and(|mut entries| entries.next().is_none())
    })
    .await
    .unwrap_or(false)
}

/// `git diff` between two checkpoints (`diffCheckpoints`). A patch over
/// `max_output_bytes` comes back cut at that many bytes; the caller marks it.
pub async fn diff(request: DiffRequest<'_>) -> VcsResult<Vec<u8>> {
    const OP: &str = "GitVcsDriver.checkpoints.diffCheckpoints";
    if request.file_paths.as_ref().is_some_and(Vec::is_empty) {
        return Ok(Vec::new());
    }
    let mut args: Vec<String> = [
        "-c",
        "diff.relative=false",
        "-c",
        "diff.suppressBlankEmpty=false",
        "diff",
    ]
    .map(str::to_owned)
    .to_vec();
    match request.format {
        DiffFormat::Numstat => args.extend(["--numstat".to_owned(), "-z".to_owned()]),
        DiffFormat::Patch => args.push("--patch".to_owned()),
    }
    args.extend(
        [
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--submodule=short",
            "--src-prefix=a/",
            "--dst-prefix=b/",
        ]
        .map(str::to_owned),
    );
    if request.ignore_whitespace {
        args.push("--ignore-all-space".to_owned());
    }
    args.push(format!("{}^{{commit}}", request.from_ref));
    args.push(format!("{}^{{commit}}", request.to_ref));
    if let Some(paths) = &request.file_paths {
        args.push("--".to_owned());
        args.extend(paths.iter().map(|p| format!(":(top,literal){p}")));
    }
    let on_limit = match request.format {
        DiffFormat::Numstat => OnLimit::Fail,
        DiffFormat::Patch => OnLimit::Truncate,
    };
    let out = git(OP, request.cwd, args)
        .max_stdout(request.max_output_bytes, on_limit)
        .allow_exit(&[1, 128])
        .timeout(CAPTURE_TIMEOUT)
        .run()
        .await?;
    if out.code != 0 {
        let detail = out.stderr.trim();
        return Err(VcsError::invalid(
            OP,
            &request.cwd.to_string_lossy(),
            if detail.is_empty() {
                "Checkpoint ref is unavailable for diff operation.".to_owned()
            } else {
                detail.to_owned()
            },
        ));
    }
    Ok(out.stdout)
}

/// `parseTurnDiffFilesFromNumstat`: `-z` numstat records, sorted by path.
pub fn parse_numstat(numstat: &[u8]) -> Vec<FileSummary> {
    let text = String::from_utf8_lossy(numstat);
    let records: Vec<&str> = text.split('\0').collect();
    let mut files = Vec::new();
    let mut index = 0;
    while let Some(record) = records.get(index) {
        index += 1;
        let mut parts = record.splitn(3, '\t');
        let (Some(adds), Some(dels), Some(rest)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let count = |s: &str| -> Option<u64> {
            if s == "-" {
                Some(0)
            } else if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
                s.parse().ok()
            } else {
                None
            }
        };
        let (Some(additions), Some(deletions)) = (count(adds), count(dels)) else {
            continue;
        };
        let (path, previous_path) = if rest.is_empty() {
            let previous = records.get(index).map(|s| (*s).to_owned());
            let path = records.get(index + 1).map(|s| (*s).to_owned());
            index += 2;
            (path.unwrap_or_default(), previous)
        } else {
            (rest.to_owned(), None)
        };
        if path.is_empty() {
            continue;
        }
        files.push(FileSummary {
            path,
            previous_path,
            additions,
            deletions,
        });
    }
    // `localeCompare`; byte order for ASCII paths, the common case.
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files
}

/// `isGitImport`: a changed file the turn did not write (a pull, a rebase).
pub fn is_git_import(file: &FileSummary, authored: Option<&BTreeSet<String>>) -> bool {
    authored.is_some_and(|authored| {
        !authored.contains(&file.path)
            && file
                .previous_path
                .as_ref()
                .is_none_or(|p| !authored.contains(p))
    })
}

async fn lines(cwd: &Path, args: Vec<String>, stdin: Option<String>) -> VcsResult<Vec<String>> {
    let mut all = vec!["-c".to_owned(), "log.showSignature=false".to_owned()];
    all.extend(args);
    let mut command = git("GitVcsDriver.checkpoints.listAuthoredPaths", cwd, all)
        .max_stdout(DIFF_MAX_OUTPUT_BYTES, OnLimit::Fail)
        .timeout(CAPTURE_TIMEOUT);
    if let Some(stdin) = stdin {
        command = command.stdin(stdin.into_bytes());
    }
    Ok(command
        .text()
        .await?
        .split('\n')
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect())
}

async fn paths(cwd: &Path, args: Vec<String>, stdin: Option<String>) -> VcsResult<Vec<String>> {
    let mut all: Vec<String> = ["-c", "diff.relative=false", "-c", "log.showSignature=false"]
        .map(str::to_owned)
        .to_vec();
    all.extend(args);
    all.extend(["--name-only", "-z", "--no-renames", "--no-ext-diff"].map(str::to_owned));
    let mut command = git("GitVcsDriver.checkpoints.listAuthoredPaths", cwd, all)
        .max_stdout(DIFF_MAX_OUTPUT_BYTES, OnLimit::Fail)
        .timeout(CAPTURE_TIMEOUT);
    if let Some(stdin) = stdin {
        command = command.stdin(stdin.into_bytes());
    }
    let out = command.run().await?;
    Ok(String::from_utf8_lossy(&out.stdout)
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .collect())
}

/// The paths the turn between two checkpoints wrote itself (`listAuthoredPaths`). `None`
/// when `HEAD` did not move: every changed path is then the turn's.
pub async fn authored_paths(
    cwd: &Path,
    from_ref: &str,
    to_ref: &str,
) -> VcsResult<Option<BTreeSet<String>>> {
    let heads = lines(
        cwd,
        vec![
            "log".into(),
            "--no-walk=unsorted".into(),
            "--format=%ct %P".into(),
            format!("{from_ref}^{{commit}}"),
            format!("{to_ref}^{{commit}}"),
        ],
        None,
    )
    .await?;
    let field = |line: Option<&String>, i: usize| -> String {
        line.and_then(|l| l.split(' ').nth(i))
            .unwrap_or_default()
            .to_owned()
    };
    let captured_at = field(heads.first(), 0);
    let start_head = field(heads.first(), 1);
    let end_head = field(heads.get(1), 1);
    if start_head.is_empty() || end_head.is_empty() || start_head == end_head {
        return Ok(None);
    }
    let since = format!("--since=@{captured_at}");
    let recent = lines(
        cwd,
        vec![
            "rev-list".into(),
            since.clone(),
            format!("{start_head}..{end_head}"),
        ],
        None,
    )
    .await?;
    let mut all: BTreeSet<String> = BTreeSet::new();
    for list in [
        paths(
            cwd,
            vec![
                "diff".into(),
                start_head.clone(),
                format!("{from_ref}^{{commit}}"),
            ],
            None,
        )
        .await?,
        paths(
            cwd,
            vec![
                "diff".into(),
                end_head.clone(),
                format!("{to_ref}^{{commit}}"),
            ],
            None,
        )
        .await?,
        paths(
            cwd,
            vec![
                "log".into(),
                "--format=".into(),
                "--diff-merges=remerge".into(),
                format!("{end_head}..{start_head}"),
            ],
            None,
        )
        .await?,
    ] {
        all.extend(list);
    }
    let imported = if recent.is_empty() {
        BTreeSet::new()
    } else {
        imported_commits(cwd, &since, &start_head)
            .await
            .unwrap_or_default()
    };
    let own: Vec<&String> = recent.iter().filter(|c| !imported.contains(*c)).collect();
    if !own.is_empty() {
        let stdin = own.iter().map(|c| format!("{c}\n")).collect::<String>();
        all.extend(
            paths(
                cwd,
                vec![
                    "log".into(),
                    "--no-walk=unsorted".into(),
                    "--stdin".into(),
                    "--format=".into(),
                    "--diff-merges=remerge".into(),
                ],
                Some(stdin),
            )
            .await?,
        );
    }
    Ok(Some(all))
}

/// Commits a fetch delivered since the previous checkpoint and that no reflog shows this
/// repository making (`listImportedCommits`).
async fn imported_commits(
    cwd: &Path,
    since: &str,
    start_head: &str,
) -> VcsResult<BTreeSet<String>> {
    let entries: Vec<(String, bool, String)> = lines(
        cwd,
        vec![
            "log".into(),
            "--walk-reflogs".into(),
            "--all".into(),
            since.to_owned(),
            "--format=%H %gD %gs".into(),
        ],
        None,
    )
    .await?
    .into_iter()
    .map(|line| {
        let mut parts = line.splitn(3, ' ');
        let commit = parts.next().unwrap_or_default().to_owned();
        let selector = parts.next().unwrap_or_default();
        let subject = parts.next().unwrap_or_default().to_owned();
        (commit, selector.starts_with("refs/remotes/"), subject)
    })
    .collect();
    let fetched_tips: BTreeSet<&String> = entries
        .iter()
        .filter(|(_, fetched, subject)| *fetched && subject != "update by push")
        .map(|(commit, ..)| commit)
        .collect();
    if fetched_tips.is_empty() {
        return Ok(BTreeSet::new());
    }
    let created_here: BTreeSet<&String> = entries
        .iter()
        .filter(|(_, fetched, subject)| !*fetched && !is_ref_move(subject))
        .map(|(commit, ..)| commit)
        .collect();
    let mut stdin: String = fetched_tips.iter().map(|c| format!("{c}\n")).collect();
    stdin.push_str(&format!("^{start_head}\n"));
    let fetched = lines(
        cwd,
        vec!["rev-list".into(), since.to_owned(), "--stdin".into()],
        Some(stdin),
    )
    .await?;
    Ok(fetched
        .into_iter()
        .filter(|c| !created_here.contains(c))
        .collect())
}

/// Deletes checkpoint refs (`deleteCheckpointRefs`); a ref that is gone is fine.
pub async fn delete_refs(cwd: &Path, refs: &[String]) -> VcsResult<()> {
    for reference in refs {
        git(
            "GitVcsDriver.checkpoints.deleteCheckpointRefs",
            cwd,
            ["update-ref", "-d", reference],
        )
        .allow_exit(&[1, 128])
        .run()
        .await
        .map_err(|e: ProcessError| VcsError::from(e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numstat_reads_renames_and_binary_files() {
        let raw = b"3\t1\tsrc/b.rs\0-\t-\timg.png\0\
0\t0\t\0old.txt\0new.txt\0junk\0";
        let files = parse_numstat(raw);
        assert_eq!(
            files,
            vec![
                FileSummary {
                    path: "img.png".into(),
                    previous_path: None,
                    additions: 0,
                    deletions: 0
                },
                FileSummary {
                    path: "new.txt".into(),
                    previous_path: Some("old.txt".into()),
                    additions: 0,
                    deletions: 0
                },
                FileSummary {
                    path: "src/b.rs".into(),
                    previous_path: None,
                    additions: 3,
                    deletions: 1
                },
            ]
        );
    }

    #[test]
    fn imports_need_an_authored_set() {
        let file = FileSummary {
            path: "a".into(),
            previous_path: Some("b".into()),
            additions: 1,
            deletions: 0,
        };
        assert!(!is_git_import(&file, None));
        let authored: BTreeSet<String> = ["b".to_owned()].into();
        assert!(!is_git_import(&file, Some(&authored)));
        assert!(is_git_import(&file, Some(&BTreeSet::new())));
    }

    #[test]
    fn ref_moves_match_the_t3_pattern() {
        for subject in [
            "",
            "checkout: moving from a to b",
            "reset: moving to HEAD~1",
            "rebase (finish): returning to refs/heads/x",
            "pull: Fast-forward",
            "merge origin/main: Fast-forward",
        ] {
            assert!(is_ref_move(subject), "{subject:?}");
        }
        for subject in [
            "commit: add file",
            "commit (amend): fix",
            "merge topic: Merge made by the 'ort' strategy.",
            "checkouts are fun",
        ] {
            assert!(!is_ref_move(subject), "{subject:?}");
        }
    }
}
