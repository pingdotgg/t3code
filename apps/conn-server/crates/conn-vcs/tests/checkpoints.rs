//! Turn checkpoints on scratch repositories: capture, diff, authored paths, restore, delete.

#![expect(
    clippy::unwrap_used,
    reason = "test helpers: a failure should fail the test"
)]

use std::path::{Path, PathBuf};

use conn_vcs::checkpoint::{
    self, Captured, DiffFormat, DiffRequest, TRUNCATED_MARKER, checkpoint_ref,
};

/// A temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "conn-vcs-checkpoint-{label}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(std::fs::canonicalize(&dir).unwrap())
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args([
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
        ])
        .args(args)
        .current_dir(cwd)
        .env("GIT_AUTHOR_NAME", "test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn write(dir: &Path, path: &str, text: &str) {
    let file = dir.join(path);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, text).unwrap();
}

fn commit_all(dir: &Path, message: &str) {
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-qm", message]);
}

fn repo(label: &str) -> TempDir {
    let dir = TempDir::new(label);
    git(dir.path(), &["init", "-q", "-b", "main"]);
    write(dir.path(), "a.txt", "one\n");
    commit_all(dir.path(), "init");
    dir
}

fn read(dir: &TempDir, path: &str) -> Option<String> {
    std::fs::read_to_string(dir.path().join(path)).ok()
}

async fn patch(dir: &TempDir, from: &str, to: &str) -> String {
    let bytes = checkpoint::diff(DiffRequest {
        cwd: dir.path(),
        from_ref: from,
        to_ref: to,
        ignore_whitespace: false,
        format: DiffFormat::Patch,
        max_output_bytes: checkpoint::DIFF_MAX_OUTPUT_BYTES,
        file_paths: None,
    })
    .await
    .unwrap();
    String::from_utf8(bytes).unwrap()
}

#[test]
fn refs_match_the_t3_server() {
    // Computed with Node: sha256 hex, first 32 digits, base64url (CheckpointService.ts).
    assert_eq!(
        checkpoint_ref("checkpoint-scope:thread:thread%3Aabc:name:root", 3),
        "refs/t3/orchestration-v2/checkpoints/YjQ1ZmVhYmQ0YWEzZjA4Mzk3YzljMTFkYmVmYmU5Mjg/ordinal/3",
        "ref name"
    );
}

#[tokio::test]
async fn capture_keeps_the_user_index_and_records_untracked_files() {
    let dir = repo("capture");
    let (r0, r1) = (checkpoint_ref("s", 0), checkpoint_ref("s", 1));
    git(dir.path(), &["add", "a.txt"]);
    write(dir.path(), "staged.txt", "staged\n");
    git(dir.path(), &["add", "staged.txt"]);
    let index_before = git(dir.path(), &["ls-files", "--stage"]);

    assert_eq!(
        checkpoint::capture(dir.path(), &r0).await.unwrap(),
        Captured::Ready,
        "baseline"
    );
    write(dir.path(), "a.txt", "one\ntwo\n");
    write(dir.path(), "new/b.txt", "bee\n");
    assert_eq!(
        checkpoint::capture(dir.path(), &r1).await.unwrap(),
        Captured::Ready,
        "after the turn"
    );

    assert_eq!(
        git(dir.path(), &["ls-files", "--stage"]),
        index_before,
        "the user's index is untouched"
    );
    assert!(
        git(dir.path(), &["status", "--porcelain"]).contains("?? new/"),
        "the working tree is untouched"
    );
    let head = git(dir.path(), &["rev-parse", "HEAD"]);
    let commit = git(dir.path(), &["cat-file", "-p", &r1]);
    assert!(
        commit.contains(&format!("parent {}", head.trim())),
        "HEAD is the first parent: {commit}"
    );
    assert!(
        commit.contains("author T3 Code <t3code@users.noreply.github.com>"),
        "{commit}"
    );
    assert!(
        commit.ends_with(&format!("t3 checkpoint ref={r1}\n")),
        "{commit}"
    );
    let common = git(dir.path(), &["rev-parse", "--git-common-dir"]);
    let leftovers: Vec<_> = std::fs::read_dir(dir.path().join(common.trim()))
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("t3-checkpoint-index-")
        })
        .collect();
    assert!(leftovers.is_empty(), "the scratch index is removed");

    let diff = patch(&dir, &r0, &r1).await;
    assert!(diff.contains("diff --git a/a.txt b/a.txt"), "{diff}");
    assert!(diff.contains("+two"), "{diff}");
    assert!(
        diff.contains("b/new/b.txt"),
        "untracked files are in the checkpoint: {diff}"
    );
    assert!(
        !diff.contains("staged.txt"),
        "staged.txt is in both: {diff}"
    );

    let numstat = checkpoint::diff(DiffRequest {
        cwd: dir.path(),
        from_ref: &r0,
        to_ref: &r1,
        ignore_whitespace: false,
        format: DiffFormat::Numstat,
        max_output_bytes: checkpoint::DIFF_MAX_OUTPUT_BYTES,
        file_paths: None,
    })
    .await
    .unwrap();
    let files: Vec<_> = checkpoint::parse_numstat(&numstat)
        .into_iter()
        .map(|f| (f.path, f.additions, f.deletions))
        .collect();
    assert_eq!(
        files,
        [("a.txt".to_owned(), 1, 0), ("new/b.txt".to_owned(), 1, 0)],
        "numstat"
    );
    assert_eq!(
        checkpoint::authored_paths(dir.path(), &r0, &r1)
            .await
            .unwrap(),
        None,
        "HEAD did not move"
    );
}

#[tokio::test]
async fn an_unchanged_tree_gives_an_empty_diff_and_ignored_files_stay_out() {
    let dir = repo("unchanged");
    write(dir.path(), ".gitignore", "target/\n");
    commit_all(dir.path(), "ignore");
    let (r0, r1) = (checkpoint_ref("s", 0), checkpoint_ref("s", 1));
    checkpoint::capture(dir.path(), &r0).await.unwrap();
    write(dir.path(), "target/big.bin", "ignored\n");
    checkpoint::capture(dir.path(), &r1).await.unwrap();
    let tree = |r: &str| git(dir.path(), &["rev-parse", &format!("{r}^{{tree}}")]);
    assert_eq!(tree(&r0), tree(&r1), "same tree");
    assert_eq!(patch(&dir, &r0, &r1).await, "", "empty diff");
}

#[tokio::test]
async fn an_unborn_branch_and_a_folder_without_git() {
    let dir = TempDir::new("unborn");
    assert!(
        !checkpoint::is_repository(dir.path()).await.unwrap(),
        "no repository"
    );
    git(dir.path(), &["init", "-q", "-b", "main"]);
    assert!(
        checkpoint::is_repository(dir.path()).await.unwrap(),
        "a repository"
    );
    write(dir.path(), "x.txt", "x\n");
    let r = checkpoint_ref("s", 0);
    assert_eq!(
        checkpoint::capture(dir.path(), &r).await.unwrap(),
        Captured::Ready,
        "unborn"
    );
    let commit = git(dir.path(), &["cat-file", "-p", &r]);
    assert!(
        !commit.contains("parent "),
        "no parent on an unborn branch: {commit}"
    );
    assert!(
        checkpoint::has_ref(dir.path(), &r).await.unwrap(),
        "ref exists"
    );
    assert!(
        !checkpoint::has_ref(dir.path(), &checkpoint_ref("s", 9))
            .await
            .unwrap(),
        "absent ref"
    );
}

#[tokio::test]
async fn restore_puts_files_back_and_removes_new_ones() {
    let dir = repo("restore");
    write(dir.path(), "keep.txt", "untracked but old\n");
    let r0 = checkpoint_ref("s", 0);
    checkpoint::capture(dir.path(), &r0).await.unwrap();
    write(dir.path(), "a.txt", "changed\n");
    std::fs::remove_file(dir.path().join("keep.txt")).unwrap();
    write(dir.path(), "made/by/turn.txt", "new\n");
    write(dir.path(), ".gitignore", "hidden.txt\n");
    write(dir.path(), "hidden.txt", "hidden by the new ignore file\n");

    assert!(
        checkpoint::restore(dir.path(), &r0).await.unwrap(),
        "restored"
    );
    assert_eq!(
        read(&dir, "a.txt").as_deref(),
        Some("one\n"),
        "tracked file back"
    );
    assert_eq!(
        read(&dir, "keep.txt").as_deref(),
        Some("untracked but old\n"),
        "file back"
    );
    assert!(!dir.path().join("made").exists(), "new folder removed");
    assert!(
        !dir.path().join(".gitignore").exists(),
        "new ignore file removed"
    );
    assert!(
        !dir.path().join("hidden.txt").exists(),
        "what it hid is removed too"
    );
    assert_eq!(
        git(dir.path(), &["status", "--porcelain"]),
        "?? keep.txt\n",
        "index reset to HEAD"
    );
    assert!(
        !checkpoint::restore(dir.path(), &checkpoint_ref("s", 7))
            .await
            .unwrap(),
        "a missing ref restores nothing"
    );
}

#[tokio::test]
async fn authored_paths_leave_out_a_pulled_commit() {
    let root = TempDir::new("authored");
    let origin = root.path().join("origin");
    std::fs::create_dir_all(&origin).unwrap();
    git(&origin, &["init", "-q", "-b", "main"]);
    write(&origin, "base.txt", "base\n");
    commit_all(&origin, "base");
    git(root.path(), &["clone", "-q", "origin", "work"]);
    let work = root.path().join("work");
    let (r0, r1) = (checkpoint_ref("s", 0), checkpoint_ref("s", 1));
    checkpoint::capture(&work, &r0).await.unwrap();
    // A second passes so the checkpoint's commit time is before the fetch.
    std::thread::sleep(std::time::Duration::from_millis(1100));
    write(&origin, "upstream.txt", "theirs\n");
    commit_all(&origin, "upstream");
    git(&work, &["pull", "-q", "--ff-only"]);
    write(&work, "mine.txt", "mine\n");
    checkpoint::capture(&work, &r1).await.unwrap();

    let authored = checkpoint::authored_paths(&work, &r0, &r1)
        .await
        .unwrap()
        .expect("HEAD moved");
    assert!(authored.contains("mine.txt"), "{authored:?}");
    assert!(
        !authored.contains("upstream.txt"),
        "the pull is an import: {authored:?}"
    );
}

#[tokio::test]
async fn a_patch_over_the_limit_is_cut() {
    let dir = repo("limit");
    let (r0, r1) = (checkpoint_ref("s", 0), checkpoint_ref("s", 1));
    checkpoint::capture(dir.path(), &r0).await.unwrap();
    write(dir.path(), "big.txt", &"line\n".repeat(1000));
    checkpoint::capture(dir.path(), &r1).await.unwrap();
    let cut = checkpoint::diff(DiffRequest {
        cwd: dir.path(),
        from_ref: &r0,
        to_ref: &r1,
        ignore_whitespace: false,
        format: DiffFormat::Patch,
        max_output_bytes: 100,
        file_paths: None,
    })
    .await
    .unwrap();
    assert_eq!(cut.len(), 100, "kept the first 100 bytes");
    assert_eq!(TRUNCATED_MARKER, "\n\n[truncated]", "marker");
    checkpoint::delete_refs(dir.path(), &[r1.clone(), checkpoint_ref("s", 5)])
        .await
        .unwrap();
    assert!(
        !checkpoint::has_ref(dir.path(), &r1).await.unwrap(),
        "deleted"
    );
}
