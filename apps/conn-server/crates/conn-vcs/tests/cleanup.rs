//! The Git checks of worktree cleanup against real repositories, ported from T3's
//! `storageCleanup.test.ts` ("storage cleanup reports and local file policies").

#![expect(
    clippy::unwrap_used,
    reason = "test helpers: a failure should fail the test"
)]

#[expect(dead_code, reason = "shared fixtures; this file uses part of them")]
mod support;

use std::path::{Path, PathBuf};

use conn_vcs::cleanup::{self, KeepWhen};
use support::{Fixture, commit_all, git, write};

/// A linked worktree of the fixture on `feature`, with one commit beyond `main`.
fn worktree(fx: &Fixture) -> PathBuf {
    let path = fx.root.path().join("worktrees").join("feature");
    git(
        &fx.work,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feature",
            path.to_str().unwrap(),
        ],
    );
    path
}

async fn changes(cwd: &Path, keep: KeepWhen) -> Option<String> {
    cleanup::local_changes(cwd, keep).await.unwrap()
}

#[tokio::test]
async fn a_clean_worktree_has_no_local_changes_in_any_mode() {
    let fx = Fixture::new("cleanup-clean");
    let wt = worktree(&fx);
    for keep in [
        KeepWhen::AnyLocalFiles,
        KeepWhen::UncommittedChanges,
        KeepWhen::TrackedChanges,
    ] {
        assert_eq!(changes(&wt, keep).await, None, "{keep:?}");
    }
}

/// T3: "keeps staged edits in tracked-only mode", and tracked edits in every mode.
#[tokio::test]
async fn tracked_and_staged_edits_keep_the_worktree_in_every_mode() {
    let fx = Fixture::new("cleanup-tracked");
    let wt = worktree(&fx);
    write(&wt, "README.md", "# edited\n");
    write(&wt, "src/lib.rs", "pub fn one() -> u32 {\n    9\n}\n");
    git(&wt, &["add", "src/lib.rs"]);
    for keep in [
        KeepWhen::AnyLocalFiles,
        KeepWhen::UncommittedChanges,
        KeepWhen::TrackedChanges,
    ] {
        assert_eq!(
            changes(&wt, keep).await.as_deref(),
            Some("has uncommitted changes (2 files)"),
            "{keep:?}"
        );
    }
}

#[tokio::test]
async fn untracked_files_keep_the_worktree_unless_only_tracked_changes_count() {
    let fx = Fixture::new("cleanup-untracked");
    let wt = worktree(&fx);
    write(&wt, "notes/todo.txt", "x\n");
    assert_eq!(
        changes(&wt, KeepWhen::UncommittedChanges).await.as_deref(),
        Some("has uncommitted changes (1 file)")
    );
    assert_eq!(changes(&wt, KeepWhen::TrackedChanges).await, None);
}

#[tokio::test]
async fn ignored_files_keep_the_worktree_only_for_any_local_files_and_never_node_modules() {
    let fx = Fixture::new("cleanup-ignored");
    let wt = worktree(&fx);
    write(&wt, ".gitignore", "node_modules/\n.env\n");
    write(&wt, "apps/web/package.json", "{}\n");
    commit_all(&wt, "ignore");
    write(&wt, "node_modules/pkg/index.js", "x\n");
    write(&wt, "apps/web/node_modules/pkg/index.js", "x\n");
    assert_eq!(changes(&wt, KeepWhen::AnyLocalFiles).await, None);
    write(&wt, ".env", "SECRET=1\n");
    assert_eq!(
        changes(&wt, KeepWhen::AnyLocalFiles).await.as_deref(),
        Some("has ignored files (.env)")
    );
    assert_eq!(changes(&wt, KeepWhen::UncommittedChanges).await, None);
}

/// T3: "keeps a worktree whose flagged file changed" for `--assume-unchanged` and
/// `--skip-worktree`, and removes one whose flagged files are unchanged.
#[tokio::test]
async fn changes_hidden_from_git_status_keep_the_worktree() {
    for flag in ["--assume-unchanged", "--skip-worktree"] {
        let fx = Fixture::new("cleanup-hidden");
        let wt = worktree(&fx);
        git(&wt, &["update-index", flag, "README.md"]);
        assert_eq!(changes(&wt, KeepWhen::TrackedChanges).await, None, "{flag}");
        write(&wt, "README.md", "# hidden edit\n");
        let status = git(&wt, &["status", "--porcelain"]);
        assert!(status.is_empty(), "git status hides it: {status}");
        assert_eq!(
            changes(&wt, KeepWhen::TrackedChanges).await.as_deref(),
            Some("has uncommitted changes hidden from git status (README.md)"),
            "{flag}"
        );
    }
}

/// The executable bit is a tracked change too, while `core.fileMode` holds.
#[cfg(unix)]
#[tokio::test]
async fn a_mode_change_hidden_from_git_status_keeps_the_worktree() {
    use std::os::unix::fs::PermissionsExt;
    for flag in ["--assume-unchanged", "--skip-worktree"] {
        let fx = Fixture::new("cleanup-hidden-mode");
        let wt = worktree(&fx);
        git(&wt, &["update-index", flag, "README.md"]);
        let readme = wt.join("README.md");
        std::fs::set_permissions(&readme, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(git(&wt, &["status", "--porcelain"]).is_empty(), "{flag}");
        assert_eq!(
            changes(&wt, KeepWhen::TrackedChanges).await.as_deref(),
            Some("has uncommitted changes hidden from git status (README.md)"),
            "{flag}"
        );
        git(&wt, &["config", "core.fileMode", "false"]);
        assert_eq!(
            changes(&wt, KeepWhen::TrackedChanges).await,
            None,
            "{flag} without core.fileMode"
        );
    }
}

#[tokio::test]
async fn a_switched_or_detached_branch_counts_as_changed() {
    let fx = Fixture::new("cleanup-branch");
    let wt = worktree(&fx);
    assert!(!cleanup::branch_changed(&wt, Some("feature")).await.unwrap());
    assert!(cleanup::branch_changed(&wt, Some("other")).await.unwrap());
    git(&wt, &["checkout", "-q", "--detach"]);
    assert!(cleanup::branch_changed(&wt, Some("feature")).await.unwrap());
    let gone = fx.root.path().join("gone");
    assert!(
        cleanup::branch_changed(&gone, Some("feature"))
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn a_held_index_lock_fails_the_branch_check() {
    let fx = Fixture::new("cleanup-lock");
    let wt = worktree(&fx);
    let index = git(&wt, &["rev-parse", "--git-path", "index"]);
    std::fs::write(wt.join(format!("{}.lock", index.trim())), "").unwrap();
    let error = cleanup::branch_changed(&wt, Some("feature"))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("index is locked"), "{error}");
}

#[tokio::test]
async fn only_a_linked_worktree_at_its_top_counts_as_one() {
    let fx = Fixture::new("cleanup-linked");
    let wt = worktree(&fx);
    assert!(cleanup::is_linked_worktree(&wt).await);
    assert!(
        !cleanup::is_linked_worktree(&fx.work).await,
        "main checkout"
    );
    assert!(
        !cleanup::is_linked_worktree(&wt.join("src")).await,
        "a subfolder"
    );
    let plain = fx.root.path().join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    assert!(!cleanup::is_linked_worktree(&plain).await, "plain folder");
    assert_eq!(
        std::fs::canonicalize(cleanup::owning_repository(&wt).await.unwrap()).unwrap(),
        std::fs::canonicalize(&fx.work).unwrap()
    );
}

/// T3: "keeps a worktree that contains a nested Git repository".
#[tokio::test]
async fn a_nested_repository_keeps_the_worktree() {
    let fx = Fixture::new("cleanup-nested");
    let wt = worktree(&fx);
    assert_eq!(cleanup::nested_repository(&wt, &[]), None);
    write(&wt, ".gitignore", "vendor/\n");
    commit_all(&wt, "ignore vendor");
    let nested = wt.join("vendor/lib");
    std::fs::create_dir_all(&nested).unwrap();
    git(&nested, &["init", "-q"]);
    assert_eq!(
        cleanup::nested_repository(&wt, &[]),
        Some("contains a nested Git repository")
    );
    assert_eq!(
        changes(&wt, KeepWhen::UncommittedChanges).await,
        None,
        "git status omits it"
    );
}

fn submodule_fixture(fx: &Fixture) -> (PathBuf, PathBuf) {
    // A second repository, pushed to its own bare remote, used as a submodule.
    let lib_origin = fx.root.path().join("lib.git");
    let lib = fx.root.path().join("lib");
    git(
        fx.root.path(),
        &[
            "init",
            "-q",
            "--bare",
            "-b",
            "main",
            lib_origin.to_str().unwrap(),
        ],
    );
    git(
        fx.root.path(),
        &[
            "clone",
            "-q",
            lib_origin.to_str().unwrap(),
            lib.to_str().unwrap(),
        ],
    );
    git(&lib, &["checkout", "-q", "-b", "main"]);
    write(&lib, "lib.txt", "lib\n");
    commit_all(&lib, "lib");
    git(&lib, &["push", "-q", "-u", "origin", "main"]);
    let wt = worktree(fx);
    git(
        &wt,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            lib_origin.to_str().unwrap(),
            "lib",
        ],
    );
    commit_all(&wt, "add lib");
    (wt.clone(), wt.join("lib"))
}

/// T3: submodule commits on no remote-tracking ref keep the worktree; pushed ones force it.
#[tokio::test]
async fn submodule_commits_not_on_a_remote_keep_the_worktree() {
    let fx = Fixture::new("cleanup-submodule");
    let (wt, lib) = submodule_fixture(&fx);
    let pushed = cleanup::submodule_removal(&wt, KeepWhen::UncommittedChanges).await;
    assert_eq!(pushed.reason, None, "{pushed:?}");
    assert!(pushed.force, "git needs --force for submodules");
    git(&lib, &["config", "user.name", "test"]);
    git(&lib, &["config", "user.email", "test@example.com"]);
    write(&lib, "lib.txt", "local\n");
    commit_all(&lib, "local only");
    let kept = cleanup::submodule_removal(&wt, KeepWhen::UncommittedChanges).await;
    assert_eq!(
        kept.reason.as_deref(),
        Some("submodule has commits not on a remote-tracking ref")
    );
}

#[tokio::test]
async fn submodule_local_changes_keep_the_worktree() {
    let fx = Fixture::new("cleanup-submodule-dirty");
    let (wt, lib) = submodule_fixture(&fx);
    write(&lib, "scratch.txt", "x\n");
    let kept = cleanup::submodule_removal(&wt, KeepWhen::UncommittedChanges).await;
    assert_eq!(
        kept.reason.as_deref(),
        Some("submodule has uncommitted changes (1 file)")
    );
}

#[tokio::test]
async fn the_remote_names_its_default_branch_and_integration_follows_ancestry() {
    let fx = Fixture::new("cleanup-integrated");
    let wt = worktree(&fx);
    assert_eq!(
        cleanup::remote_default_branch(&fx.work, "origin")
            .await
            .unwrap()
            .as_deref(),
        Some("main")
    );
    git(&fx.work, &["remote", "set-head", "origin", "-d"]);
    assert_eq!(
        cleanup::remote_default_branch(&fx.work, "origin")
            .await
            .unwrap()
            .as_deref(),
        Some("main"),
        "ls-remote answers without refs/remotes/origin/HEAD"
    );
    let head = git(&wt, &["rev-parse", "HEAD"]).trim().to_owned();
    assert!(
        cleanup::is_ancestor(&wt, &head, "refs/remotes/origin/main")
            .await
            .unwrap()
    );
    write(&wt, "feature.txt", "f\n");
    let ahead = commit_all(&wt, "feature");
    assert!(
        !cleanup::is_ancestor(&wt, &ahead, "refs/remotes/origin/main")
            .await
            .unwrap()
    );
    git(&wt, &["push", "-q", "origin", "feature:main"]);
    cleanup::fetch_tracking_branch(&fx.work, "origin", "main")
        .await
        .unwrap();
    assert!(
        cleanup::is_ancestor(&wt, &ahead, "refs/remotes/origin/main")
            .await
            .unwrap()
    );
}

/// A detached HEAD's commits live on only in the worktree's HEAD log. An amended commit does
/// not count: its branch's own log, which removal keeps, still holds it.
#[tokio::test]
async fn only_commits_the_head_log_alone_holds_are_lost() {
    let fx = Fixture::new("cleanup-head-log");
    let wt = worktree(&fx);
    let lost = |wt: PathBuf, repo: PathBuf| async move {
        cleanup::head_log_holds_lost_commits(&wt, &repo)
            .await
            .unwrap()
    };
    assert!(!lost(wt.clone(), fx.work.clone()).await, "a fresh worktree");
    write(&wt, "a.txt", "a\n");
    commit_all(&wt, "first");
    git(&wt, &["commit", "-q", "--amend", "-m", "amended"]);
    assert!(!lost(wt.clone(), fx.work.clone()).await, "an amend");
    git(&wt, &["checkout", "-q", "--detach"]);
    write(&wt, "b.txt", "b\n");
    commit_all(&wt, "detached");
    git(&wt, &["checkout", "-q", "feature"]);
    assert!(lost(wt.clone(), fx.work.clone()).await, "a detached commit");
}
