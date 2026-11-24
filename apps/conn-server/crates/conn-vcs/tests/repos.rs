//! Every operation against real temporary repositories. Offline: the "remote" is a bare
//! repository in the same temp folder.

#![expect(
    clippy::unwrap_used,
    reason = "test helpers: a failure should fail the test"
)]

mod support;

use std::path::PathBuf;

use conn_contract::{
    ReviewBranchCommitsInput, ReviewDiffChangeType as ChangeType, ReviewDiffFileContentsInput,
    ReviewDiffPreviewInput, ReviewDiffPreviewInputFile,
    ReviewDiffPreviewInputSourceKind as InputKind, ReviewDiffPreviewSourceKind as Kind,
    VcsCreateRefInput, VcsDriverKind, VcsInitInput, VcsListRefsInput, VcsListRefsInputRefKind,
    VcsPullResultStatus, VcsSwitchRefInput,
};
use conn_vcs::{
    VcsHub, commit, hub, refs, review, status,
    worktree::{self, CreateWorktree, Removal},
};
use support::{Fixture, TempDir, commit_all, git, write};

fn preview_input(cwd: &str) -> ReviewDiffPreviewInput {
    ReviewDiffPreviewInput {
        cwd: cwd.into(),
        base_ref: None,
        commit_sha: None,
        ignore_whitespace: None,
        source_kind: None,
        tracked_only: None,
        metadata_only: None,
        file: None,
    }
}

fn list_input(cwd: &str) -> VcsListRefsInput {
    VcsListRefsInput {
        cwd: cwd.into(),
        query: None,
        cursor: None,
        include_matching_remote_refs: None,
        ref_kind: None,
        refresh: None,
        limit: None,
    }
}

#[tokio::test]
async fn local_status_counts_tracked_untracked_and_branch_changes() {
    let fx = Fixture::new("local");
    let clean = status::local_status(&fx.work).await.unwrap();
    assert!(clean.is_repo && clean.has_primary_remote && clean.is_default_ref);
    assert_eq!(clean.ref_name.as_deref(), Some("main"));
    assert!(!clean.has_working_tree_changes);
    assert_eq!(
        clean.working_tree.root_path.as_deref(),
        Some(fx.cwd().as_str())
    );

    git(&fx.work, &["checkout", "-q", "-b", "feature/x"]);
    write(&fx.work, "src/lib.rs", "pub fn one() -> u32 {\n    2\n}\n");
    commit_all(&fx.work, "two");
    write(&fx.work, "README.md", "# repo\nmore\n");
    write(&fx.work, "notes.txt", "a\nb\nc\n");

    let local = status::local_status(&fx.work).await.unwrap();
    assert_eq!(local.ref_name.as_deref(), Some("feature/x"));
    assert!(!local.is_default_ref);
    assert!(local.has_working_tree_changes);
    let files: Vec<_> = local
        .working_tree
        .files
        .iter()
        .map(|f| (f.path.as_str(), f.insertions, f.deletions))
        .collect();
    assert_eq!(files, [("notes.txt", 0, 0), ("README.md", 1, 0)]);
    assert_eq!(
        (local.working_tree.insertions, local.working_tree.deletions),
        (1, 0)
    );
    // Against origin/main: the committed change, the README line, and the untracked file.
    let changes = local.branch_changes.unwrap();
    assert_eq!(changes.base_ref.as_deref(), Some("origin/main"));
    assert_eq!((changes.insertions, changes.deletions), (1 + 1 + 3, 1));

    let outside = TempDir::new("plain");
    let not_repo = status::local_status(outside.path()).await.unwrap();
    assert!(!not_repo.is_repo);
    let gone = status::local_status(&outside.path().join("missing"))
        .await
        .unwrap();
    assert!(!gone.is_repo);
}

/// T3's `reports net file counts from the empty tree`: before the first commit, a staged line
/// replaced in the work tree counts once (+1/-0), as the commit sheet sums it; after the
/// commit, the edit is +1/-1.
#[tokio::test]
async fn unborn_head_counts_net_changes_from_the_empty_tree() {
    let dir = TempDir::new("unborn");
    git(dir.path(), &["init", "-qb", "main"]);
    write(dir.path(), "initial.ts", "first\n");
    git(dir.path(), &["add", "initial.ts"]);
    write(dir.path(), "initial.ts", "revised\n");
    let counts = |local: &conn_contract::VcsStatusLocalResult| {
        let files: Vec<_> = local
            .working_tree
            .files
            .iter()
            .map(|f| (f.path.clone(), f.insertions, f.deletions))
            .collect();
        (
            files,
            local.working_tree.insertions,
            local.working_tree.deletions,
        )
    };
    let before = status::local_status(dir.path()).await.unwrap();
    assert_eq!(
        counts(&before),
        (vec![("initial.ts".to_owned(), 1, 0)], 1, 0)
    );
    git(dir.path(), &["commit", "-qm", "first"]);
    let after = status::local_status(dir.path()).await.unwrap();
    assert_eq!(
        counts(&after),
        (vec![("initial.ts".to_owned(), 1, 1)], 1, 1)
    );
}

/// T3's `isMissingGitCwdError`: a removed worktree reads as no repository. No git starts in
/// it, so nothing fails with "failed to start".
#[tokio::test]
async fn a_missing_folder_reads_as_no_repository() {
    let fx = Fixture::new("missing-cwd");
    let gone = fx.work.join("removed-worktree");
    let local = status::local_status(&gone).await.unwrap();
    assert!(!local.is_repo, "local status");
    assert!(status::remote_status(&gone).await.unwrap().is_none());
    status::fetch_upstream_remote(&gone)
        .await
        .expect("a fetch in a missing folder is skipped");
    assert!(
        !conn_vcs::checkpoint::is_repository(&gone)
            .await
            .expect("the checkpoint probe reads a missing folder as no repository"),
    );
}

#[tokio::test]
async fn remote_status_reads_divergence_after_fetch() {
    let fx = Fixture::new("remote");
    write(&fx.work, "a.txt", "a\n");
    commit_all(&fx.work, "local");
    let other = fx.other_clone();
    write(&other, "b.txt", "b\n");
    commit_all(&other, "remote one");
    write(&other, "c.txt", "c\n");
    commit_all(&other, "remote two");
    git(&other, &["push", "-q", "origin", "main"]);

    let before = status::remote_status(&fx.work).await.unwrap().unwrap();
    assert!(before.has_upstream);
    assert_eq!((before.ahead_count, before.behind_count), (1, 0));
    status::fetch_upstream_remote(&fx.work).await.unwrap();
    let after = status::remote_status(&fx.work).await.unwrap().unwrap();
    assert_eq!((after.ahead_count, after.behind_count), (1, 2));
    assert_eq!(after.ahead_of_default_count, Some(0));
    assert_eq!(after.pr, None);

    git(&fx.work, &["checkout", "-q", "-b", "topic"]);
    let topic = status::remote_status(&fx.work).await.unwrap().unwrap();
    assert!(!topic.has_upstream);
    // One commit ahead of origin/main (the local one), counted against the base.
    assert_eq!(topic.ahead_count, 1);
    assert_eq!(topic.ahead_of_default_count, Some(1));

    let branch = status::branch_status(&fx.work).await.unwrap();
    assert_eq!(branch.ref_name.as_deref(), Some("topic"));
    git(&fx.work, &["checkout", "-q", "--detach"]);
    let detached = status::branch_status(&fx.work).await.unwrap();
    assert_eq!((detached.ref_name, detached.is_repo), (None, Some(true)));
}

/// T3's `statusDetailsRemote`: with no usable remote default (here `origin/HEAD` names a
/// deleted `origin/master`), both `main` and `master` count as the default, even when the
/// other one exists locally.
#[tokio::test]
async fn either_conventional_branch_is_the_default_without_a_remote_default() {
    let fx = Fixture::new("dangling-remote-head");
    git(
        &fx.work,
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/master",
        ],
    );
    git(&fx.work, &["checkout", "-q", "-b", "master"]);
    write(&fx.work, "m.txt", "m\n");
    commit_all(&fx.work, "ahead of main");

    let local = status::local_status(&fx.work).await.unwrap();
    assert_eq!(local.ref_name.as_deref(), Some("master"));
    assert!(local.is_default_ref, "master is a default branch");
    let remote = status::remote_status(&fx.work).await.unwrap().unwrap();
    assert_eq!(remote.ahead_of_default_count, Some(0));
}

#[tokio::test]
async fn list_refs_orders_filters_and_pages() {
    let fx = Fixture::new("refs");
    let other = fx.other_clone();
    git(&other, &["checkout", "-q", "-b", "remote-only"]);
    commit_all_empty(&other, "x");
    git(&other, &["push", "-q", "origin", "remote-only"]);
    git(&fx.work, &["fetch", "-q", "origin"]);
    git(&fx.work, &["branch", "local-a"]);
    git(&fx.work, &["branch", "local-b"]);

    let all = refs::list_refs(list_input(&fx.cwd())).await.unwrap();
    assert!(all.is_repo && all.has_primary_remote);
    assert_eq!(all.is_at_repository_root, Some(true));
    let names: Vec<_> = all.refs.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(names[0], "main", "current first");
    assert!(all.refs[0].current && all.refs[0].is_default);
    assert_eq!(
        all.refs[0].worktree_path.as_deref(),
        Some(fx.cwd().as_str())
    );
    assert_eq!(
        all.refs[0].upstream_ref.as_deref(),
        Some("refs/remotes/origin/main")
    );
    // origin/main is hidden behind local main; origin/remote-only is listed.
    assert!(!names.contains(&"origin/main"));
    let remote = all
        .refs
        .iter()
        .find(|r| r.name == "origin/remote-only")
        .unwrap();
    assert_eq!(remote.remote_name.as_deref(), Some("origin"));
    assert_eq!(all.total_count, 4);

    let mut input = list_input(&fx.cwd());
    input.include_matching_remote_refs = Some(true);
    input.ref_kind = Some(VcsListRefsInputRefKind::Remote);
    let remotes = refs::list_refs(input).await.unwrap();
    assert!(remotes.refs.iter().all(|r| r.is_remote == Some(true)));
    assert!(
        remotes
            .refs
            .iter()
            .any(|r| r.name == "origin/main" && r.is_default)
    );

    let mut input = list_input(&fx.cwd());
    input.query = Some("LOCAL".into());
    input.limit = Some(1);
    let page = refs::list_refs(input).await.unwrap();
    assert_eq!(
        (page.refs.len(), page.total_count, page.next_cursor),
        (1, 2, Some(1))
    );

    let outside = TempDir::new("norepo");
    let none = refs::list_refs(list_input(&outside.path().to_string_lossy()))
        .await
        .unwrap();
    assert!(!none.is_repo);
}

/// T3's split-directory regression: Git lists a `--separate-git-dir` repository's metadata
/// folder as the main checkout. It is no worktree to reuse: the current branch gets the real
/// checkout, a linked checkout sees no reusable path for `main`, and an ordinary linked
/// worktree keeps its path.
#[tokio::test]
async fn list_refs_never_offers_the_git_metadata_folder_as_a_worktree() {
    let root = TempDir::new("refs-split");
    let checkout = root.path().join("checkout");
    let metadata = root.path().join("git-metadata");
    std::fs::create_dir_all(&checkout).unwrap();
    git(
        &checkout,
        &[
            "init",
            "-qb",
            "main",
            &format!("--separate-git-dir={}", metadata.display()),
        ],
    );
    commit_all_empty(&checkout, "seed");
    let current = |list: &conn_contract::VcsListRefsResult| {
        list.refs
            .iter()
            .find(|r| r.current)
            .and_then(|r| r.worktree_path.clone())
            .map(|p| std::fs::canonicalize(p).unwrap())
    };
    let from_main = refs::list_refs(list_input(&checkout.to_string_lossy()))
        .await
        .unwrap();
    assert_eq!(
        current(&from_main),
        Some(std::fs::canonicalize(&checkout).unwrap())
    );

    let linked = root.path().join("linked");
    git(
        &checkout,
        &["worktree", "add", "-qb", "topic", &linked.to_string_lossy()],
    );
    let mut input = list_input(&linked.to_string_lossy());
    input.refresh = Some(true);
    input.query = Some("main".into());
    input.ref_kind = Some(VcsListRefsInputRefKind::Local);
    let from_linked = refs::list_refs(input).await.unwrap();
    assert_eq!(from_linked.is_at_repository_root, Some(true));
    let main = from_linked.refs.iter().find(|r| r.name == "main").unwrap();
    assert!(!main.current);
    assert_eq!(
        main.worktree_path, None,
        "the metadata folder is no checkout"
    );

    // Git keeps a trailing space in the folder name; only its final newline is output framing.
    let spaced = TempDir::new("refs-split-space");
    let checkout = spaced.path().join("checkout");
    let metadata = spaced.path().join("git-metadata ");
    std::fs::create_dir_all(&checkout).unwrap();
    git(
        &checkout,
        &[
            "init",
            "-qb",
            "main",
            &format!("--separate-git-dir={}", metadata.display()),
        ],
    );
    commit_all_empty(&checkout, "seed");
    let linked = spaced.path().join("linked");
    git(
        &checkout,
        &["worktree", "add", "-qb", "topic", &linked.to_string_lossy()],
    );
    let mut input = list_input(&linked.to_string_lossy());
    input.refresh = Some(true);
    input.query = Some("main".into());
    input.ref_kind = Some(VcsListRefsInputRefKind::Local);
    let from_linked = refs::list_refs(input).await.unwrap();
    let main = from_linked.refs.iter().find(|r| r.name == "main").unwrap();
    assert_eq!(
        main.worktree_path, None,
        "a metadata folder named with a trailing space is no checkout"
    );

    // The conventional layout: a linked worktree's path is offered.
    let fx = Fixture::new("refs-linked");
    let other = fx.root.path().join("other-worktree");
    git(
        &fx.work,
        &["worktree", "add", "-qb", "other", &other.to_string_lossy()],
    );
    let listed = refs::list_refs(list_input(&fx.cwd())).await.unwrap();
    let other_ref = listed.refs.iter().find(|r| r.name == "other").unwrap();
    assert_eq!(
        other_ref
            .worktree_path
            .as_deref()
            .map(|p| std::fs::canonicalize(p).unwrap()),
        Some(std::fs::canonicalize(&other).unwrap())
    );
}

fn commit_all_empty(dir: &std::path::Path, message: &str) {
    git(dir, &["commit", "-q", "--allow-empty", "-m", message]);
}

#[tokio::test]
async fn switch_create_pull_and_init() {
    let fx = Fixture::new("mutate");
    let other = fx.other_clone();
    git(&other, &["checkout", "-q", "-b", "feature"]);
    commit_all_empty(&other, "f");
    git(&other, &["push", "-q", "origin", "feature"]);
    git(&fx.work, &["fetch", "-q", "origin"]);

    // A remote-only branch becomes a local tracking branch.
    let switched = refs::switch_ref(VcsSwitchRefInput {
        cwd: fx.cwd(),
        ref_name: "origin/feature".into(),
    })
    .await
    .unwrap();
    assert_eq!(switched.ref_name.as_deref(), Some("feature"));
    assert_eq!(
        git(
            &fx.work,
            &["rev-parse", "--abbrev-ref", "feature@{upstream}"]
        )
        .trim(),
        "origin/feature"
    );

    let created = refs::create_ref(VcsCreateRefInput {
        cwd: fx.cwd(),
        ref_name: "made-here".into(),
        switch_ref: Some(true),
    })
    .await
    .unwrap();
    assert_eq!(created.ref_name, "made-here");
    assert_eq!(
        status::branch_status(&fx.work)
            .await
            .unwrap()
            .ref_name
            .as_deref(),
        Some("made-here")
    );
    let error = refs::create_ref(VcsCreateRefInput {
        cwd: fx.cwd(),
        ref_name: "made-here".into(),
        switch_ref: None,
    })
    .await
    .unwrap_err();
    let shape = conn_contract::to_json(&error.to_git_command_error());
    assert_eq!(shape["_tag"], "GitCommandError");
    assert_eq!(shape["reason"], "branch_already_exists");
    assert!(
        !shape.to_string().contains("fatal"),
        "no stderr text reaches the client"
    );

    let detached = refs::pull(&fx.work).await;
    assert!(detached.is_err(), "made-here has no upstream");

    refs::switch_ref(VcsSwitchRefInput {
        cwd: fx.cwd(),
        ref_name: "main".into(),
    })
    .await
    .unwrap();
    let up_to_date = refs::pull(&fx.work).await.unwrap();
    assert_eq!(up_to_date.status, VcsPullResultStatus::SkippedUpToDate);
    git(&other, &["checkout", "-q", "main"]);
    commit_all_empty(&other, "m");
    git(&other, &["push", "-q", "origin", "main"]);
    let pulled = refs::pull(&fx.work).await.unwrap();
    assert_eq!(pulled.status, VcsPullResultStatus::Pulled);
    assert_eq!(pulled.upstream_ref.as_deref(), Some("origin/main"));

    let fresh = TempDir::new("init");
    refs::init(VcsInitInput {
        cwd: fresh.path().to_string_lossy().into(),
        kind: None,
    })
    .await
    .unwrap();
    assert!(fresh.path().join(".git").is_dir());
    let jj = refs::init(VcsInitInput {
        cwd: fresh.path().to_string_lossy().into(),
        kind: Some(VcsDriverKind::Jj),
    })
    .await
    .unwrap_err();
    assert_eq!(
        conn_contract::to_json(&jj.to_init_error())["_tag"],
        "VcsUnsupportedOperationError"
    );
}

/// A clone whose `main` is one commit behind `origin/main`, with `other` pushed at the new commit.
fn behind_remote(label: &str) -> (Fixture, String) {
    let fx = Fixture::new(label);
    let other = fx.other_clone();
    write(&other, "remote.txt", "remote change\n");
    let remote_head = commit_all(&other, "upstream delta");
    git(
        &other,
        &["push", "-q", "origin", "main", "HEAD:refs/heads/other"],
    );
    (fx, remote_head)
}

/// T3 "pulls past an unrelated lock with custom fetch mapping=false/true".
#[tokio::test]
async fn pull_passes_an_unrelated_ref_lock() {
    for custom_mapping in [false, true] {
        let (fx, remote_head) = behind_remote("pull-lock");
        // A tag named like the branch must not make the upstream-only pull ambiguous.
        git(&fx.work, &["tag", "main"]);
        let prefix = if custom_mapping {
            git(&fx.work, &["remote", "rename", "origin", "team/upstream"]);
            git(
                &fx.work,
                &[
                    "config",
                    "remote.team/upstream.fetch",
                    "+refs/heads/*:refs/remotes/team/upstream/mapped/*",
                ],
            );
            git(
                &fx.work,
                &[
                    "update-ref",
                    "refs/remotes/team/upstream/mapped/main",
                    "HEAD",
                ],
            );
            "refs/remotes/team/upstream/mapped"
        } else {
            "refs/remotes/origin"
        };
        let lock = fx.work.join(format!(".git/{prefix}/other.lock"));
        std::fs::write(&lock, "fixture lock").unwrap();

        let pulled = refs::pull(&fx.work).await.unwrap();

        assert_eq!(
            pulled.status,
            VcsPullResultStatus::Pulled,
            "{custom_mapping}"
        );
        assert_eq!(git(&fx.work, &["rev-parse", "HEAD"]).trim(), remote_head);
        assert_eq!(
            git(&fx.work, &["rev-parse", &format!("{prefix}/main")]).trim(),
            remote_head
        );
        assert!(fx.work.join("remote.txt").exists());
        assert_eq!(std::fs::read_to_string(&lock).unwrap(), "fixture lock");
    }
}

/// T3 "reports an upstream lock after the fallback without removing it".
#[tokio::test]
async fn pull_reports_a_locked_upstream_and_keeps_the_lock() {
    let (fx, _) = behind_remote("pull-upstream-lock");
    let before = git(&fx.work, &["rev-parse", "HEAD"]);
    let lock = fx.work.join(".git/refs/remotes/origin/main.lock");
    std::fs::write(&lock, "fixture lock").unwrap();

    assert!(refs::pull(&fx.work).await.is_err());

    assert_eq!(git(&fx.work, &["rev-parse", "HEAD"]), before);
    assert!(!fx.work.join("remote.txt").exists());
    assert_eq!(std::fs::read_to_string(&lock).unwrap(), "fixture lock");
}

/// The retry pulls only the upstream captured before the first attempt. Another client
/// retargets the branch while the first fetch runs; the branch and HEAD stay put.
#[tokio::test]
async fn pull_does_not_retry_after_the_upstream_is_retargeted() {
    let (fx, _) = behind_remote("pull-retarget");
    git(
        &fx.origin,
        &["update-ref", "refs/heads/retarget", "refs/heads/main"],
    );
    let before = git(&fx.work, &["rev-parse", "HEAD"]);
    let lock = fx.work.join(".git/refs/remotes/origin/other.lock");
    std::fs::write(&lock, "fixture lock").unwrap();
    // Git runs the upload-pack command for each fetch from the local remote.
    let retarget = format!(
        "git --git-dir={} config branch.main.merge refs/heads/retarget; git upload-pack",
        fx.work.join(".git").display()
    );
    git(&fx.work, &["config", "remote.origin.uploadpack", &retarget]);

    let error = refs::pull(&fx.work).await.unwrap_err();

    assert!(format!("{error:?}").contains("origin/other"), "{error:?}");
    assert_eq!(git(&fx.work, &["rev-parse", "HEAD"]), before);
    assert!(!fx.work.join("remote.txt").exists());
    assert_eq!(std::fs::read_to_string(&lock).unwrap(), "fixture lock");
}

#[tokio::test]
async fn worktrees_are_created_listed_and_removed() {
    let fx = Fixture::new("wt");
    let dir = fx.root.path().join("worktrees");
    let created = worktree::create_worktree(&CreateWorktree {
        cwd: fx.work.clone(),
        ref_name: "origin/main".into(),
        new_ref_name: Some("t3/abcd1234".into()),
        base_ref_name: Some("main".into()),
        worktrees_dir: dir.clone(),
    })
    .await
    .unwrap();
    let path = created.path.clone();
    assert!(path.starts_with(dir.join("work")));
    let name = path.file_name().unwrap().to_string_lossy().into_owned();
    assert!(name.starts_with("t3-abcd1234-"), "{name}");
    assert!(path.join("README.md").exists());
    assert_eq!(
        git(&fx.work, &["config", "branch.t3/abcd1234.t3-merge-base"]).trim(),
        "main"
    );
    // Started from a remote branch: it tracks it.
    assert_eq!(
        git(&path, &["rev-parse", "--abbrev-ref", "@{upstream}"]).trim(),
        "origin/main"
    );

    let list = worktree::list_worktrees(&fx.work).await.unwrap();
    assert_eq!(list.len(), 2);
    let real = std::fs::canonicalize(&path).unwrap();
    assert!(list.iter().any(
        |w| std::fs::canonicalize(&w.path).ok() == Some(real.clone())
            && w.ref_name.as_deref() == Some("t3/abcd1234")
    ));

    // The same branch twice is refused, and the refused one leaves no branch behind.
    let again = worktree::create_worktree(&CreateWorktree {
        cwd: fx.work.clone(),
        ref_name: "main".into(),
        new_ref_name: Some("t3/abcd1234".into()),
        base_ref_name: None,
        worktrees_dir: dir.clone(),
    })
    .await
    .unwrap_err();
    assert_eq!(again.reason(), Some("branch_already_exists"));

    write(&path, "dirty.txt", "x\n");
    assert!(
        worktree::remove_worktree(&fx.work, &path, Removal::Safe)
            .await
            .is_err()
    );
    worktree::remove_worktree(&fx.work, &path, Removal::Force)
        .await
        .unwrap();
    assert!(!path.exists());
    // A folder git does not know and that is gone counts as removed, as in the TypeScript server.
    let ghost: PathBuf = dir.join("work").join("gone");
    worktree::remove_worktree(&fx.work, &ghost, Removal::Force)
        .await
        .unwrap();
    worktree::delete_branch(&fx.work, "t3/abcd1234", Removal::Force)
        .await
        .unwrap();
}

/// A linked worktree at `<root>/annexed` whose `.git` file git-annex replaced with a symlink to
/// its admin folder. The layout is built with git and a link; git-annex itself does not run.
fn annexed_worktree(fx: &Fixture) -> (PathBuf, PathBuf) {
    let path = fx.root.path().join("annexed");
    git(
        &fx.work,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feature/annexed",
            path.to_str().unwrap(),
            "main",
        ],
    );
    let admin = PathBuf::from(git(&path, &["rev-parse", "--absolute-git-dir"]).trim());
    let dot_git = path.join(".git");
    std::fs::remove_file(&dot_git).unwrap();
    std::os::unix::fs::symlink(&admin, &dot_git).unwrap();
    (path, admin)
}

/// The `.git` entry itself, so a test sees whether removal replaced it.
fn dot_git_inode(path: &std::path::Path) -> u64 {
    use std::os::unix::fs::MetadataExt;
    std::fs::symlink_metadata(path.join(".git")).unwrap().ino()
}

/// The checkout and its registration are both gone.
fn assert_removed(fx: &Fixture, path: &std::path::Path, admin: &std::path::Path) {
    assert!(std::fs::symlink_metadata(path).is_err(), "checkout kept");
    assert!(!admin.exists(), "admin folder kept");
    let listed = git(&fx.work, &["worktree", "list", "--porcelain"]);
    assert!(!listed.contains("annexed"), "{listed}");
}

/// T3 "removes a worktree whose .git file git-annex replaced with a symlink". A link inside the
/// checkout is unlinked, never followed.
#[tokio::test]
async fn removes_a_clean_git_annex_worktree() {
    for removal in [Removal::Safe, Removal::Force] {
        let fx = Fixture::new("annex");
        let (path, admin) = annexed_worktree(&fx);
        let outside = fx.root.path().join("outside");
        write(&outside, "keep.txt", "keep\n");
        if removal == Removal::Force {
            std::os::unix::fs::symlink(&outside, path.join("escape")).unwrap();
        }

        worktree::remove_worktree(&fx.work, &path, removal)
            .await
            .unwrap();

        assert_removed(&fx, &path, &admin);
        assert_eq!(
            std::fs::read_to_string(outside.join("keep.txt")).unwrap(),
            "keep\n"
        );
    }
}

/// Safe removal refuses an annexed checkout with untracked, modified or staged files, or with
/// submodules, as `git worktree remove` does, and keeps every file; force removes it.
#[tokio::test]
async fn safe_annex_removal_refuses_a_dirty_checkout() {
    for case in ["untracked", "modified", "staged", "submodules"] {
        let fx = Fixture::new("annex-dirty");
        let (path, admin) = annexed_worktree(&fx);
        match case {
            "untracked" => write(&path, "notes.txt", "draft\n"),
            "modified" => write(&path, "README.md", "draft\n"),
            "staged" => {
                write(&path, "notes.txt", "draft\n");
                git(&path, &["add", "notes.txt"]);
            }
            _ => std::fs::create_dir_all(admin.join("modules/sub")).unwrap(),
        }
        let before = git(&path, &["status", "--porcelain", "--untracked-files=all"]);
        let inode = dot_git_inode(&path);

        let refused = worktree::remove_worktree(&fx.work, &path, Removal::Safe)
            .await
            .unwrap_err()
            .to_string();

        let expected = if case == "submodules" {
            "working trees containing submodules cannot be moved or removed".to_owned()
        } else {
            format!(
                "'{}' contains modified or untracked files, use --force to delete it",
                path.display()
            )
        };
        assert!(refused.contains(&expected), "{case}: {refused}");
        assert_eq!(dot_git_inode(&path), inode, "{case}");
        assert_eq!(
            git(&path, &["status", "--porcelain", "--untracked-files=all"]),
            before,
            "{case}"
        );
        assert!(admin.exists(), "{case}");

        worktree::remove_worktree(&fx.work, &path, Removal::Force)
            .await
            .unwrap();
        assert_removed(&fx, &path, &admin);
    }
}

/// How a submodule's checkout is populated, if at all.
#[derive(Clone, Copy, Debug)]
enum Submodule {
    /// Its own `.git` directory.
    Cloned,
    /// A `gitdir:` file naming a git directory whose path ends in a space.
    GitFileTrailingSpace,
    /// `HEAD` is a symlink (`core.preferSymlinkRefs`) to a branch `pack-refs` has packed.
    SymlinkedPackedHead,
    /// A cloned `.git` git cannot read (an empty `commondir`), behind a `skip-worktree`
    /// gitlink so status stays clean. `rev-parse --resolve-git-dir` exits 128 here too.
    UnreadableGitDir,
    Unpopulated,
}

/// A populated submodule (its checkout has a `.git` git itself resolves) is refused like
/// `<admin>/modules`, as git reads the worktree's index; an unpopulated one is not.
#[tokio::test]
async fn safe_annex_removal_refuses_a_populated_submodule() {
    for layout in [
        Submodule::Cloned,
        Submodule::GitFileTrailingSpace,
        Submodule::SymlinkedPackedHead,
        Submodule::UnreadableGitDir,
        Submodule::Unpopulated,
    ] {
        let populated = !matches!(layout, Submodule::Unpopulated);
        let fx = Fixture::new("annex-submodule");
        let (path, admin) = annexed_worktree(&fx);
        let sub = fx.root.path().join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        git(&sub, &["init", "-q", "-b", "main"]);
        write(&sub, "lib.txt", "lib\n");
        let sha = commit_all(&sub, "lib");
        match layout {
            Submodule::Cloned => {
                git(&path, &["clone", "-q", sub.to_str().unwrap(), "lib"]);
            }
            Submodule::GitFileTrailingSpace => {
                let separate = fx.root.path().join("lib-git ");
                git(
                    &path,
                    &[
                        "clone",
                        "-q",
                        "--separate-git-dir",
                        separate.to_str().unwrap(),
                        sub.to_str().unwrap(),
                        "lib",
                    ],
                );
            }
            Submodule::SymlinkedPackedHead => {
                git(&path, &["clone", "-q", sub.to_str().unwrap(), "lib"]);
                let lib = path.join("lib");
                git(
                    &lib,
                    &[
                        "-c",
                        "core.preferSymlinkRefs=true",
                        "symbolic-ref",
                        "HEAD",
                        "refs/heads/main",
                    ],
                );
                git(&lib, &["pack-refs", "--all"]);
                let head = lib.join(".git/HEAD");
                assert!(head.is_symlink() && !head.is_file(), "{layout:?}");
            }
            Submodule::UnreadableGitDir => {
                git(&path, &["clone", "-q", sub.to_str().unwrap(), "lib"]);
                write(&path.join("lib"), "draft.txt", "unsaved\n");
            }
            Submodule::Unpopulated => {
                std::fs::create_dir_all(path.join("lib")).unwrap();
            }
        }
        git(
            &path,
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                &format!("160000,{},lib", sha.trim()),
            ],
        );
        git(&path, &["commit", "-q", "-m", "submodule"]);
        if matches!(layout, Submodule::UnreadableGitDir) {
            git(&path, &["update-index", "--skip-worktree", "lib"]);
            std::fs::write(path.join("lib/.git/commondir"), "").unwrap();
        }
        assert_eq!(git(&path, &["status", "--porcelain"]), "", "{layout:?}");

        let result = worktree::remove_worktree(&fx.work, &path, Removal::Safe).await;

        if !populated {
            result.unwrap();
            assert_removed(&fx, &path, &admin);
            continue;
        }
        let refused = result.unwrap_err().to_string();
        assert!(
            refused.contains("working trees containing submodules cannot be moved or removed"),
            "{refused}"
        );
        assert!(path.join("lib/lib.txt").exists(), "{layout:?}");
        assert!(path.join("lib/.git").exists(), "{layout:?}");
        assert!(admin.exists(), "{layout:?}");

        worktree::remove_worktree(&fx.work, &path, Removal::Force)
            .await
            .unwrap();
        assert_removed(&fx, &path, &admin);
    }
}

/// The dirty check reads the linked checkout even when its `config.worktree` points
/// `core.worktree` at the main checkout, as git sets `GIT_DIR` and `GIT_WORK_TREE`.
#[tokio::test]
async fn safe_annex_removal_checks_the_linked_checkout() {
    let fx = Fixture::new("annex-core-worktree");
    let (path, admin) = annexed_worktree(&fx);
    git(&fx.work, &["config", "extensions.worktreeConfig", "true"]);
    git(
        &path,
        &[
            "config",
            "--worktree",
            "core.worktree",
            fx.work.to_str().unwrap(),
        ],
    );
    write(&path, "README.md", "draft\n");

    let refused = worktree::remove_worktree(&fx.work, &path, Removal::Safe)
        .await
        .unwrap_err()
        .to_string();

    assert!(
        refused.contains("contains modified or untracked files"),
        "{refused}"
    );
    assert_eq!(
        std::fs::read_to_string(path.join("README.md")).unwrap(),
        "draft\n"
    );
    assert!(admin.exists());

    worktree::remove_worktree(&fx.work, &path, Removal::Force)
        .await
        .unwrap();
    assert_removed(&fx, &path, &admin);
}

/// A locked annexed worktree is refused, forced or not, as `git worktree remove --force` does.
#[tokio::test]
async fn annex_removal_refuses_a_locked_worktree() {
    let fx = Fixture::new("annex-locked");
    let (path, admin) = annexed_worktree(&fx);
    git(
        &fx.work,
        &["worktree", "lock", "--reason", "on a stick", "annexed"],
    );

    for removal in [Removal::Safe, Removal::Force] {
        let refused = worktree::remove_worktree(&fx.work, &path, removal)
            .await
            .unwrap_err()
            .to_string();
        assert!(
            refused.contains("cannot remove a locked working tree, lock reason: on a stick"),
            "{refused}"
        );
        assert!(path.join("README.md").exists(), "{removal:?}");
        assert!(admin.join("locked").exists(), "{removal:?}");
    }

    git(&fx.work, &["worktree", "unlock", "annexed"]);
    worktree::remove_worktree(&fx.work, &path, Removal::Safe)
        .await
        .unwrap();
    assert_removed(&fx, &path, &admin);
}

/// Removal reads an annexed checkout's metadata only from this repository's own
/// `<common dir>/worktrees/<name>`, and refuses before touching the checkout otherwise.
#[tokio::test]
async fn annex_removal_refuses_a_link_outside_the_repository() {
    let fx = Fixture::new("annex-outside");
    let (path, admin) = annexed_worktree(&fx);
    // A copy of the admin folder outside the repository, whose gitdir still points back.
    let outside = fx.root.path().join("outside-admin");
    git(
        fx.root.path(),
        &["init", "-q", "--bare", outside.to_str().unwrap()],
    );
    for file in ["gitdir", "HEAD"] {
        std::fs::copy(admin.join(file), outside.join(file)).unwrap();
    }
    let dot_git = path.join(".git");
    std::fs::remove_file(&dot_git).unwrap();
    std::os::unix::fs::symlink(&outside, &dot_git).unwrap();
    let inode = dot_git_inode(&path);

    for removal in [Removal::Safe, Removal::Force] {
        assert!(
            worktree::remove_worktree(&fx.work, &path, removal)
                .await
                .is_err()
        );
        assert_eq!(dot_git_inode(&path), inode, "{removal:?}");
        assert_eq!(std::fs::read_link(&dot_git).unwrap(), outside);
        assert!(path.join("README.md").exists());
        assert!(outside.join("HEAD").exists());
        assert!(admin.exists());
    }
    assert!(git(&fx.work, &["worktree", "list"]).contains("annexed"));

    // With the link pointing home again, the same checkout is removed.
    std::fs::remove_file(&dot_git).unwrap();
    std::os::unix::fs::symlink(&admin, &dot_git).unwrap();
    worktree::remove_worktree(&fx.work, &path, Removal::Safe)
        .await
        .unwrap();
    assert_removed(&fx, &path, &admin);
}

/// The admin folder's `gitdir` must name this checkout's `.git`, not another file in it.
#[tokio::test]
async fn annex_removal_refuses_a_backlink_to_another_file() {
    let fx = Fixture::new("annex-backlink");
    let (path, admin) = annexed_worktree(&fx);
    let gitdir = std::fs::read_to_string(admin.join("gitdir")).unwrap();
    std::fs::write(
        admin.join("gitdir"),
        format!("{}\n", path.join("README.md").display()),
    )
    .unwrap();
    let inode = dot_git_inode(&path);

    for removal in [Removal::Safe, Removal::Force] {
        assert!(
            worktree::remove_worktree(&fx.work, &path, removal)
                .await
                .is_err()
        );
        assert_eq!(dot_git_inode(&path), inode, "{removal:?}");
        assert_eq!(std::fs::read_link(path.join(".git")).unwrap(), admin);
        assert!(path.join("README.md").exists());
        assert!(admin.exists());
    }

    std::fs::write(admin.join("gitdir"), gitdir).unwrap();
    worktree::remove_worktree(&fx.work, &path, Removal::Safe)
        .await
        .unwrap();
    assert_removed(&fx, &path, &admin);
}

/// A user's own `.git.conn-swap*` is an untracked file like any other: safe removal refuses the
/// checkout and keeps it, and only force deletes it.
#[tokio::test]
async fn annex_removal_treats_a_swap_named_file_as_untracked() {
    let fx = Fixture::new("annex-user-swap");
    let (path, admin) = annexed_worktree(&fx);
    write(&path, ".git.conn-swap-mine", "mine\n");

    assert!(
        worktree::remove_worktree(&fx.work, &path, Removal::Safe)
            .await
            .is_err()
    );
    assert_eq!(
        std::fs::read_to_string(path.join(".git.conn-swap-mine")).unwrap(),
        "mine\n"
    );
    assert_eq!(std::fs::read_link(path.join(".git")).unwrap(), admin);

    worktree::remove_worktree(&fx.work, &path, Removal::Force)
        .await
        .unwrap();
    assert_removed(&fx, &path, &admin);
}

#[tokio::test]
async fn diff_preview_shows_working_tree_branch_range_and_commit() {
    let fx = Fixture::new("review");
    git(&fx.work, &["checkout", "-q", "-b", "feature"]);
    write(&fx.work, "src/lib.rs", "pub fn one() -> u32 {\n    2\n}\n");
    let sha = commit_all(&fx.work, "Change one to two\n\nbody");
    write(&fx.work, "README.md", "# repo\nmore\n");
    write(&fx.work, "new.txt", "fresh\n");

    let preview = review::diff_preview(preview_input(&fx.cwd()))
        .await
        .unwrap();
    assert_eq!(preview.sources.len(), 2);
    let working = &preview.sources[0];
    assert_eq!(
        (working.id.as_str(), working.kind),
        ("working-tree", Kind::WorkingTree)
    );
    assert_eq!(working.title, "Uncommitted");
    let paths: Vec<_> = working
        .files
        .as_ref()
        .unwrap()
        .iter()
        .map(|f| f.path.as_str())
        .collect();
    assert_eq!(
        paths,
        ["README.md", "new.txt"],
        "untracked files show as additions"
    );
    assert!(working.diff.contains("+fresh"));
    assert!(!working.truncated);
    let range = &preview.sources[1];
    assert_eq!(range.title, "Changes vs origin/main");
    assert_eq!(range.base_ref.as_deref(), Some("origin/main"));
    assert_eq!(range.head_ref.as_deref(), Some("feature"));
    assert_eq!(range.files.as_ref().unwrap().len(), 3);
    // The untracked file stays untracked: the real index was not touched.
    assert!(git(&fx.work, &["status", "--porcelain"]).contains("?? new.txt"));

    let mut input = preview_input(&fx.cwd());
    input.metadata_only = Some(true);
    input.source_kind = Some(InputKind::BranchRange);
    let meta = review::diff_preview(input).await.unwrap();
    assert_eq!(meta.sources.len(), 1);
    assert_eq!(meta.sources[0].patches_deferred, Some(true));
    assert!(meta.sources[0].diff.is_empty());

    let mut input = preview_input(&fx.cwd());
    input.tracked_only = Some(true);
    input.source_kind = Some(InputKind::WorkingTree);
    let tracked = review::diff_preview(input).await.unwrap();
    assert_eq!(tracked.incomplete, Some(true));
    assert_eq!(tracked.sources[0].files.as_ref().unwrap().len(), 1);

    let mut input = preview_input(&fx.cwd());
    input.commit_sha = Some(sha.clone());
    let commit = review::diff_preview(input).await.unwrap();
    let source = &commit.sources[0];
    assert_eq!(source.kind, Kind::Commit);
    assert_eq!(source.title, format!("Commit {}", &sha[..7]));
    assert_eq!(source.commit_subject.as_deref(), Some("Change one to two"));
    assert!(source.diff.contains("-    1\n+    2"));

    let mut input = preview_input(&fx.cwd());
    input.file = Some(ReviewDiffPreviewInputFile {
        path: "new.txt".into(),
        previous_path: None,
        source_kind: Kind::WorkingTree,
    });
    let one = review::diff_preview(input).await.unwrap();
    assert_eq!(one.sources[0].files.as_ref().unwrap().len(), 1);

    let mut input = preview_input(&fx.cwd());
    input.commit_sha = Some("not-a-sha".into());
    let bad = review::diff_preview(input).await.unwrap_err();
    assert_eq!(
        conn_contract::to_json(&bad.to_review_error())["detail"],
        "Selected commit is invalid or no longer available."
    );

    let outside = TempDir::new("noreview");
    let empty = review::diff_preview(preview_input(&outside.path().to_string_lossy()))
        .await
        .unwrap();
    assert!(empty.sources.is_empty());
}

/// T3's `keeps the review working beside a nested repository`: `git init` inside the checkout
/// leaves the working-tree review whole. The new repository joins it as a gitlink once it has
/// its first commit, and the real index stays clean.
#[tokio::test]
async fn the_review_survives_an_unborn_nested_repository() {
    let fx = Fixture::new("review-nested");
    write(&fx.work, "README.md", "# repo\nafter\n");
    write(&fx.work, "notes.txt", "new notes\n");
    let mut input = preview_input(&fx.cwd());
    input.source_kind = Some(InputKind::WorkingTree);
    let working = || async {
        let preview = review::diff_preview(input.clone()).await.unwrap();
        preview
            .sources
            .into_iter()
            .find(|s| s.kind == Kind::WorkingTree)
            .unwrap()
            .diff
    };
    let baseline = working().await;
    assert!(baseline.contains("+after") && baseline.contains("+new notes"));

    git(&fx.work, &["init", "-q", "scaffold"]);
    let beside_unborn = working().await;
    assert!(
        beside_unborn.contains("+after") && beside_unborn.contains("+new notes"),
        "{beside_unborn}"
    );
    assert!(!beside_unborn.contains("scaffold"), "{beside_unborn}");

    git(
        &fx.work.join("scaffold"),
        &["commit", "-qm", "initial", "--allow-empty"],
    );
    let beside_born = working().await;
    assert!(beside_born.contains("+new notes"), "{beside_born}");
    assert!(beside_born.contains("scaffold"), "{beside_born}");
    assert_eq!(git(&fx.work, &["diff", "--cached", "--name-only"]), "");
}

#[tokio::test]
async fn diff_preview_truncates_large_patches() {
    let fx = Fixture::new("big");
    let big: String = (0..20_000).map(|i| format!("line {i}\n")).collect();
    write(&fx.work, "big.txt", &big);
    let mut input = preview_input(&fx.cwd());
    input.source_kind = Some(InputKind::WorkingTree);
    let preview = review::diff_preview(input).await.unwrap();
    let source = &preview.sources[0];
    assert!(source.truncated);
    assert_eq!(source.diff.len(), review::PATCH_MAX_BYTES);
    assert_eq!(source.files.as_ref().unwrap()[0].additions.0, 20_000.0);
}

/// T3's `loads working-tree contents as Git diffs them under the ident attribute`: Git expands
/// `$Id$` in the checkout of a file marked `ident`, and the full-file request returns the
/// keyword collapsed on both sides, so only the edited line differs and the desktop loader
/// expands the hidden context. An unmarked file's literal `$Id: literal $` stays.
#[tokio::test]
async fn working_contents_collapse_a_git_ident_keyword_like_the_diff() {
    let dir = TempDir::new("ident");
    let repo = dir.path();
    git(repo, &["init", "-qb", "main"]);
    write(repo, ".gitattributes", "record.txt ident\n");
    let trailing: String = (1..=24).map(|i| format!("unchanged line {i}\n")).collect();
    let canonical = format!("$Id$\nfirst\n{trailing}");
    write(repo, "record.txt", &canonical);
    write(repo, "plain.txt", "first\n");
    commit_all(repo, "ident");
    std::fs::remove_file(repo.join("record.txt")).unwrap();
    git(repo, &["checkout-index", "-f", "record.txt"]);
    let expanded = std::fs::read_to_string(repo.join("record.txt")).unwrap();
    assert!(
        expanded.starts_with("$Id: ") && !expanded.starts_with("$Id$"),
        "{expanded}"
    );
    write(repo, "record.txt", &expanded.replacen("first", "edited", 1));
    write(repo, "plain.txt", "$Id: literal $\n");
    let contents = |file: &str| ReviewDiffFileContentsInput {
        cwd: repo.to_string_lossy().into_owned(),
        source_kind: Kind::WorkingTree,
        change_type: ChangeType::Change,
        base_ref: Some("HEAD".into()),
        head_ref: None,
        old_path: file.into(),
        new_path: file.into(),
    };
    let record = review::diff_file_contents(contents("record.txt"), |_| false)
        .await
        .unwrap();
    assert_eq!(record.old_contents, canonical);
    assert_eq!(
        record.new_contents,
        canonical.replacen("first", "edited", 1)
    );
    let plain = review::diff_file_contents(contents("plain.txt"), |_| false)
        .await
        .unwrap();
    assert_eq!(plain.new_contents, "$Id: literal $\n");
}

/// T3 collapses `$Id: … $` in a file marked `ident` only after the `filter.unspecified.*`
/// lookup exits 1 with nothing found; a lookup that exits otherwise keeps the text read. The
/// same file shows both: a healthy lookup collapses the keyword, and a malformed `GIT_CONFIG`
/// (read only by `git config`, so `check-attr` and `hash-object` still work) keeps it. The
/// variable is process-wide, so that case runs in a copy of this test binary.
#[tokio::test]
async fn working_ident_text_collapses_only_after_a_clean_filter_lookup() {
    let (_dir, input) = literal_ident_file("ident-healthy");
    let healthy = review::diff_file_contents(input, |_| false).await.unwrap();
    assert_eq!(healthy.new_contents, "$Id$\nedited\n");

    let dir = TempDir::new("ident-bad-config");
    let config = dir.path().join("malformed-config");
    std::fs::write(&config, "[filter\n").unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "literal_ident_text_under_a_failing_filter_lookup",
            "--ignored",
        ])
        .env("GIT_CONFIG", &config)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && stdout.contains("1 passed"),
        "{stdout}{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
#[ignore = "run by working_ident_text_collapses_only_after_a_clean_filter_lookup"]
async fn literal_ident_text_under_a_failing_filter_lookup() {
    let (dir, input) = literal_ident_file("ident-literal");
    let lookup = std::process::Command::new("git")
        .args(["config", "--get-regexp", "^filter\\."])
        .current_dir(dir.path())
        .output()
        .unwrap();
    assert!(
        !matches!(lookup.status.code(), Some(0 | 1)),
        "Git read a healthy configuration: {lookup:?}"
    );
    let contents = review::diff_file_contents(input, |_| false).await.unwrap();
    assert_eq!(contents.new_contents, LITERAL_IDENT_TEXT);
}

const LITERAL_IDENT_TEXT: &str = "$Id: literal $\nedited\n";

/// A repository whose `record.txt`, marked with a boolean `ident`, holds
/// [`LITERAL_IDENT_TEXT`] in the working tree.
fn literal_ident_file(label: &str) -> (TempDir, ReviewDiffFileContentsInput) {
    let dir = TempDir::new(label);
    let repo = dir.path();
    git(repo, &["init", "-qb", "main"]);
    write(repo, ".gitattributes", "record.txt ident\n");
    write(repo, "record.txt", "first\n");
    commit_all(repo, "seed");
    write(repo, "record.txt", LITERAL_IDENT_TEXT);
    let input = ReviewDiffFileContentsInput {
        cwd: repo.to_string_lossy().into_owned(),
        source_kind: Kind::WorkingTree,
        change_type: ChangeType::Change,
        base_ref: Some("HEAD".into()),
        head_ref: None,
        old_path: "record.txt".into(),
        new_path: "record.txt".into(),
    };
    (dir, input)
}

#[tokio::test]
async fn file_contents_and_branch_commits() {
    let fx = Fixture::new("contents");
    git(&fx.work, &["checkout", "-q", "-b", "feature"]);
    write(&fx.work, "src/lib.rs", "pub fn one() -> u32 {\n    2\n}\n");
    let sha = commit_all(&fx.work, "two");
    write(&fx.work, "src/lib.rs", "pub fn one() -> u32 {\n    3\n}\n");

    let contents =
        |kind, change, base: Option<&str>, head: Option<&str>| ReviewDiffFileContentsInput {
            cwd: fx.cwd(),
            source_kind: kind,
            change_type: change,
            base_ref: base.map(str::to_owned),
            head_ref: head.map(str::to_owned),
            old_path: "src/lib.rs".into(),
            new_path: "src/lib.rs".into(),
        };
    let working = review::diff_file_contents(
        contents(Kind::WorkingTree, ChangeType::Change, Some("HEAD"), None),
        |_| false,
    )
    .await
    .unwrap();
    assert!(working.old_contents.contains("    2"));
    assert!(working.new_contents.contains("    3"));
    let range = review::diff_file_contents(
        contents(
            Kind::BranchRange,
            ChangeType::Change,
            Some("origin/main"),
            Some("feature"),
        ),
        |_| false,
    )
    .await
    .unwrap();
    assert!(range.old_contents.contains("    1"));
    let parent = git(&fx.work, &["rev-parse", &format!("{sha}^")])
        .trim()
        .to_owned();
    let commit = review::diff_file_contents(
        contents(Kind::Commit, ChangeType::Change, Some(&parent), Some(&sha)),
        |_| false,
    )
    .await
    .unwrap();
    assert!(commit.old_contents.contains("    1") && commit.new_contents.contains("    2"));
    let stale = review::diff_file_contents(
        contents(Kind::Commit, ChangeType::Change, Some(&sha), Some(&sha)),
        |_| false,
    )
    .await
    .unwrap_err();
    assert!(stale.to_string().contains("Selected commit changed"));
    let mut escape = contents(Kind::WorkingTree, ChangeType::Change, None, None);
    escape.new_path = "../outside.txt".into();
    assert!(
        review::diff_file_contents(escape, |_| false)
            .await
            .unwrap_err()
            .to_string()
            .contains("outside")
    );

    // A working file in the server's own state is not served (T3 `isServerInternalPath`).
    let internal = review::diff_file_contents(
        contents(Kind::WorkingTree, ChangeType::Change, Some("HEAD"), None),
        |path: &std::path::Path| path.ends_with("src/lib.rs"),
    )
    .await
    .unwrap_err();
    assert!(
        internal
            .to_string()
            .contains("Diff file 'src/lib.rs' is not available."),
        "{internal}"
    );

    let commits = review::branch_commits(ReviewBranchCommitsInput {
        cwd: fx.cwd(),
        base_ref: None,
    })
    .await
    .unwrap();
    assert!(!commits.truncated);
    assert_eq!(commits.commits.len(), 1);
    assert_eq!(commits.commits[0].sha, sha);
    assert_eq!(commits.commits[0].subject, "two");
    assert!(commits.commits[0].committed_at.contains('T'));
}

/// T3 "compares a plain recorded base with the remote that base branch tracks".
#[tokio::test]
async fn a_plain_recorded_base_compares_with_the_remote_it_tracks() {
    let fx = Fixture::new("tracked-base");
    let upstream = fx.root.path().join("upstream.git");
    git(
        fx.root.path(),
        &["init", "-q", "--bare", upstream.to_str().unwrap()],
    );
    git(
        &fx.work,
        &["remote", "add", "upstream", upstream.to_str().unwrap()],
    );
    write(&fx.work, "upstream.txt", "unrelated upstream work\n");
    commit_all(&fx.work, "upstream work");
    git(&fx.work, &["push", "-q", "-u", "upstream", "main"]);
    git(
        &fx.work,
        &["checkout", "-q", "-b", "feature/from-local-main"],
    );
    git(
        &fx.work,
        &[
            "config",
            "branch.feature/from-local-main.t3-merge-base",
            "main",
        ],
    );
    write(&fx.work, "feature.txt", "intended branch change\n");
    commit_all(&fx.work, "feature work");
    write(&fx.work, "draft.txt", "draft\n");

    let read = |base: Option<&str>| {
        let cwd = fx.cwd();
        let base = base.map(str::to_owned);
        async move {
            let mut input = preview_input(&cwd);
            input.source_kind = Some(InputKind::BranchRange);
            input.base_ref.clone_from(&base);
            let preview = review::diff_preview(input).await.unwrap();
            let range = preview
                .sources
                .into_iter()
                .find(|s| s.kind == Kind::BranchRange)
                .unwrap();
            let mut files: Vec<_> = range.files.unwrap().into_iter().map(|f| f.path).collect();
            files.sort();
            let commits = review::branch_commits(ReviewBranchCommitsInput {
                cwd,
                base_ref: base,
            })
            .await
            .unwrap();
            let subjects: Vec<_> = commits.commits.into_iter().map(|c| c.subject).collect();
            (range.base_ref.unwrap(), files, subjects)
        }
    };
    let ours = (
        "upstream/main".to_owned(),
        vec!["draft.txt".to_owned(), "feature.txt".to_owned()],
        vec!["feature work".to_owned()],
    );
    let theirs = (
        "origin/main".to_owned(),
        vec![
            "draft.txt".to_owned(),
            "feature.txt".to_owned(),
            "upstream.txt".to_owned(),
        ],
        vec!["feature work".to_owned(), "upstream work".to_owned()],
    );
    assert_eq!(read(None).await, ours);
    assert_eq!(read(Some("upstream/main")).await, ours);
    assert_eq!(read(Some("origin/main")).await, theirs);
    let local = status::local_status(&fx.work).await.unwrap();
    let changes = local.branch_changes.unwrap();
    assert_eq!(changes.base_ref.as_deref(), Some("upstream/main"));
    assert_eq!(
        status::remote_status(&fx.work)
            .await
            .unwrap()
            .unwrap()
            .ahead_count,
        1
    );

    // Retargeting local main moves the implicit base with it.
    git(
        &fx.work,
        &["branch", "-q", "--set-upstream-to=origin/main", "main"],
    );
    assert_eq!(read(None).await, theirs);
}

/// One scripted answer: the script's `async` flag and where its exit code arrives.
type ScriptAnswer = Option<(bool, tokio::sync::oneshot::Receiver<Option<i64>>)>;

/// A setup runner the test drives: each start takes the next scripted answer, and the
/// completion resolves when the test sends the exit code.
#[derive(Default)]
struct FakeRunner {
    answers: std::sync::Mutex<std::collections::VecDeque<ScriptAnswer>>,
    started: std::sync::Mutex<Vec<(String, PathBuf)>>,
    discarded: std::sync::Mutex<Vec<String>>,
    /// When set, a start waits here before it answers, as a terminal still being opened.
    opening: std::sync::Mutex<Option<std::sync::Arc<tokio::sync::Notify>>>,
}

impl FakeRunner {
    /// Queues a script; `background` is its `async` flag. Send its exit code on the sender.
    fn script(&self, background: bool) -> tokio::sync::oneshot::Sender<Option<i64>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.answers
            .lock()
            .unwrap()
            .push_back(Some((background, rx)));
        tx
    }

    fn no_script(&self) {
        self.answers.lock().unwrap().push_back(None);
    }

    /// Holds the next start until the returned gate is notified.
    fn hold_opening(&self) -> std::sync::Arc<tokio::sync::Notify> {
        let gate = std::sync::Arc::new(tokio::sync::Notify::new());
        *self.opening.lock().unwrap() = Some(gate.clone());
        gate
    }
}

impl conn_vcs::setup::SetupRunner for FakeRunner {
    fn start<'a>(
        &'a self,
        thread: &'a str,
        worktree: &'a std::path::Path,
    ) -> conn_vcs::setup::SetupFuture<'a, Result<Option<conn_vcs::setup::StartedSetup>, String>>
    {
        Box::pin(async move {
            self.started
                .lock()
                .unwrap()
                .push((thread.to_owned(), worktree.to_owned()));
            let opening = self.opening.lock().unwrap().take();
            if let Some(gate) = opening {
                gate.notified().await;
            }
            let answer = self.answers.lock().unwrap().pop_front().flatten();
            Ok(
                answer.map(|(background, rx)| conn_vcs::setup::StartedSetup {
                    name: "Setup".into(),
                    command: "pnpm i".into(),
                    terminal_id: "setup-s1".into(),
                    background,
                    completion: Box::pin(async move { rx.await.ok().flatten() }),
                }),
            )
        })
    }

    fn discard(&self, thread: &str, terminal_id: &str) {
        self.discarded
            .lock()
            .unwrap()
            .push(format!("{thread}:{terminal_id}"));
    }
}

/// Lets spawned tasks run.
async fn settle_tasks() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

/// T3's launch preparation (`ThreadLaunchService.prepareInBackground`): the setup script
/// starts in the new checkout; a script with `async: false` holds the launch until it exits
/// and fails it on a non-zero exit, removing the worktree and its branch.
#[tokio::test]
async fn provision_creates_a_worktree_and_waits_for_a_blocking_setup_script() {
    use conn_contract::{
        ProjectClonePhase as Phase, WorktreeSetupStageId as Id, WorktreeSetupStageStatus as St,
    };
    use conn_vcs::setup::{self, ProvisionError, ProvisionRequest, WorktreeSetups};
    use std::sync::Arc;

    let fx = Fixture::new("provision");
    git(&fx.work, &["tag", "launch-tag"]);
    git(&fx.work, &["push", "-q", "origin", "launch-tag"]);
    git(&fx.work, &["tag", "-d", "launch-tag"]);
    let setups = WorktreeSetups::new();
    let runner = Arc::new(FakeRunner::default());
    let request = |thread: &str| ProvisionRequest {
        thread_id: thread.into(),
        project_root: fx.work.clone(),
        base_ref: "main".into(),
        branch: None,
        start_from_origin: true,
        setup: Some(runner.clone()),
        worktrees_dir: fx.root.path().join("worktrees"),
        submodules: None,
        missing_base: setup::MissingBase::Fail,
    };
    let exit = runner.script(false);
    let launch = {
        let (setups, request) = (setups.clone(), request("t1"));
        tokio::spawn(async move { setup::provision(&setups, request).await })
    };
    while runner.started.lock().unwrap().is_empty() {
        tokio::task::yield_now().await;
    }
    settle_tasks().await;
    assert!(!launch.is_finished(), "a blocking script holds the launch");
    let running = setups.get("t1").unwrap();
    assert_eq!(
        running
            .setup_script
            .as_ref()
            .map(|s| s.terminal_id.as_str()),
        Some("setup-s1")
    );
    exit.send(Some(0)).unwrap();
    let done = launch.await.unwrap().unwrap();
    assert!(
        done.branch.starts_with("t3/") && done.branch.len() == 11,
        "{}",
        done.branch
    );
    assert!(
        git(&fx.work, &["tag", "--list", "launch-tag"])
            .trim()
            .is_empty(),
        "launch must not fetch tags"
    );
    assert!(done.path.join("README.md").exists());
    assert_eq!(
        runner.started.lock().unwrap().first().map(|s| s.1.clone()),
        Some(done.path.clone()),
        "the script runs in the new checkout"
    );
    let snapshot = setups.get("t1").unwrap();
    let stage = |id| snapshot.stages.iter().find(|s| s.id == id).unwrap().clone();
    assert_eq!(
        stage(Id::Fetch).status,
        St::Done,
        "origin exists, so it fetched"
    );
    assert_eq!(stage(Id::Checkout).status, St::Done);
    assert_eq!(stage(Id::Submodules).status, St::Skipped);
    let script = stage(Id::SetupScript);
    assert_eq!(script.status, St::Done);
    assert_eq!(script.detail.as_deref(), Some("exited with 0"));
    assert_eq!(
        snapshot.worktree_path.as_deref(),
        Some(&*done.path.to_string_lossy())
    );
    setups.agent_started("t1");
    assert_eq!(setups.get("t1").unwrap().phase, Phase::Done);

    write(&fx.work, "local-only.txt", "local base\n");
    commit_all(&fx.work, "local base");
    git(&fx.origin, &["update-ref", "-d", "refs/heads/main"]);
    runner.no_script();
    let local = setup::provision(&setups, request("deleted")).await.unwrap();
    assert_eq!(
        git(&local.path, &["rev-parse", "HEAD"]),
        git(&fx.work, &["rev-parse", "main"])
    );
    let skipped = setups.get("deleted").unwrap();
    assert!(
        skipped
            .stages
            .iter()
            .any(|s| s.id == Id::SetupScript && s.status == St::Skipped),
        "no script: the stage is skipped"
    );

    // A failing script fails the setup, closes its terminal, and removes the worktree and
    // its branch.
    let exit = runner.script(false);
    exit.send(Some(3)).unwrap();
    let failed = setup::provision(&setups, request("t2")).await.unwrap_err();
    assert!(
        matches!(failed, ProvisionError::SetupScript(ref m) if m == "Setup script exited with 3.")
    );
    let snapshot = setups.get("t2").unwrap();
    assert_eq!(snapshot.phase, Phase::Failed);
    let path = PathBuf::from(snapshot.worktree_path.unwrap());
    assert!(!path.exists());
    let branch = snapshot.branch.unwrap();
    assert!(!git(&fx.work, &["branch", "--list", &branch]).contains(&branch));
    assert_eq!(*runner.discarded.lock().unwrap(), ["t2:setup-s1"]);
}

/// T3's "deletes a claimed worktree's branch when setup is cancelled before checkout
/// returns": a cancel while `git worktree add` runs its `post-checkout` hook stops the hook's
/// whole process tree and removes the checkout and its branch.
#[tokio::test]
async fn a_cancel_during_post_checkout_removes_the_checkout_and_branch() {
    use conn_vcs::setup::{self, ProvisionError, ProvisionRequest, WorktreeSetups};
    use std::os::unix::fs::PermissionsExt;

    let fx = Fixture::new("post-checkout");
    let pids_dir = fx.root.path().join("pids");
    std::fs::create_dir_all(&pids_dir).unwrap();
    let hook = fx.work.join(".git/hooks/post-checkout");
    std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
    let pids = pids_dir.display();
    std::fs::write(
        &hook,
        format!("#!/bin/sh\necho $$ > {pids}/hook\nsleep 31 &\necho $! > {pids}/child\nwait\n"),
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let setups = WorktreeSetups::new();
    let worktrees = fx.root.path().join("worktrees");
    let request = ProvisionRequest {
        thread_id: "pc".into(),
        project_root: fx.work.clone(),
        base_ref: "main".into(),
        branch: Some("feature-pc".into()),
        start_from_origin: false,
        missing_base: conn_vcs::setup::MissingBase::Fail,
        submodules: None,
        setup: None,
        worktrees_dir: worktrees.clone(),
    };
    let run = {
        let setups = setups.clone();
        tokio::spawn(async move { setup::provision(&setups, request).await })
    };
    let pids = [
        read_pid(&pids_dir.join("hook")).await,
        read_pid(&pids_dir.join("child")).await,
    ];
    assert!(setups.cancel("pc"));
    let result = run.await.unwrap();
    let left = survivors(&pids).await;
    assert!(
        matches!(result, Err(ProvisionError::Cancelled)),
        "{result:?}"
    );
    assert_eq!(left, Vec::<u32>::new(), "the hook kept running");
    assert!(
        !git(&fx.work, &["worktree", "list", "--porcelain"]).contains("feature-pc"),
        "the checkout stayed registered"
    );
    assert!(
        !git(&fx.work, &["branch", "--list", "feature-pc"]).contains("feature-pc"),
        "the branch stayed"
    );
    let mut stack = vec![worktrees];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            assert_ne!(
                entry.file_name(),
                "feature-pc",
                "the checkout folder stayed"
            );
            if entry.path().is_dir() {
                stack.push(entry.path());
            }
        }
    }
}

/// The direct `vcs.createWorktree` RPC: a dropped call (a client that disconnects) during a
/// slow `post-checkout` hook leaves no locked checkout. Like the TypeScript server's
/// interrupt, it removes the checkout and its branch.
#[tokio::test]
async fn a_dropped_create_worktree_leaves_no_locked_checkout() {
    use std::os::unix::fs::PermissionsExt;

    let fx = Fixture::new("dropped-create");
    let pids_dir = fx.root.path().join("pids");
    std::fs::create_dir_all(&pids_dir).unwrap();
    let hook = fx.work.join(".git/hooks/post-checkout");
    std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
    let pids = pids_dir.display();
    std::fs::write(
        &hook,
        format!("#!/bin/sh\necho $$ > {pids}/hook\nsleep 31 &\necho $! > {pids}/child\nwait\n"),
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let input = CreateWorktree {
        cwd: fx.work.clone(),
        ref_name: "main".into(),
        new_ref_name: Some("feature-dropped".into()),
        base_ref_name: Some("main".into()),
        worktrees_dir: fx.root.path().join("worktrees"),
    };
    let call = tokio::spawn(async move { worktree::create_worktree(&input).await });
    let pids = [
        read_pid(&pids_dir.join("hook")).await,
        read_pid(&pids_dir.join("child")).await,
    ];
    call.abort();
    assert!(call.await.unwrap_err().is_cancelled());
    assert_eq!(
        survivors(&pids).await,
        Vec::<u32>::new(),
        "the hook kept running"
    );

    let mut list = String::new();
    for _ in 0..200 {
        list = git(&fx.work, &["worktree", "list", "--porcelain"]);
        let branch = git(&fx.work, &["branch", "--list", "feature-dropped"]);
        if !list.contains("feature-dropped") && !branch.contains("feature-dropped") {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(
        !list.contains("locked"),
        "the checkout stayed locked: {list}"
    );
    assert!(
        !list.contains("feature-dropped"),
        "the checkout stayed registered: {list}"
    );
    assert!(
        !git(&fx.work, &["branch", "--list", "feature-dropped"]).contains("feature-dropped"),
        "the branch stayed"
    );
}

/// A worktree the cleanup cannot remove (a locked one) keeps its branch, and the failed setup
/// says what it left behind instead of failing quietly.
#[tokio::test]
async fn a_worktree_cleanup_cannot_remove_keeps_its_branch_and_says_so() {
    use conn_vcs::setup::{self, ProvisionRequest, SetupFuture, StartedSetup, WorktreeSetups};

    /// A setup script that locks its worktree, then exits 3.
    struct LockingRunner;
    impl conn_vcs::setup::SetupRunner for LockingRunner {
        fn start<'a>(
            &'a self,
            _thread: &'a str,
            worktree: &'a std::path::Path,
        ) -> SetupFuture<'a, Result<Option<StartedSetup>, String>> {
            Box::pin(async move {
                git(
                    worktree,
                    &["worktree", "lock", &worktree.display().to_string()],
                );
                Ok(Some(StartedSetup {
                    name: "Setup".into(),
                    command: "git worktree lock && exit 3".into(),
                    terminal_id: "setup-s1".into(),
                    background: false,
                    completion: Box::pin(std::future::ready(Some(3))),
                }))
            })
        }
        fn discard(&self, _thread: &str, _terminal_id: &str) {}
    }

    let fx = Fixture::new("locked-cleanup");
    let setups = WorktreeSetups::new();
    let failed = setup::provision(
        &setups,
        ProvisionRequest {
            thread_id: "locked".into(),
            project_root: fx.work.clone(),
            base_ref: "main".into(),
            branch: Some("feature-locked".into()),
            start_from_origin: false,
            missing_base: conn_vcs::setup::MissingBase::Fail,
            submodules: None,
            setup: Some(std::sync::Arc::new(LockingRunner)),
            worktrees_dir: fx.root.path().join("worktrees"),
        },
    )
    .await;
    assert!(failed.is_err());
    let error = setups.get("locked").unwrap().error.unwrap_or_default();
    assert!(
        error.contains("could not be removed"),
        "the setup hid the worktree it left: {error}"
    );
    assert!(git(&fx.work, &["branch", "--list", "feature-locked"]).contains("feature-locked"));
    let path = setups.get("locked").unwrap().worktree_path.unwrap();
    git(&fx.work, &["worktree", "unlock", &path]);
}

/// T3 and Git keep the checkout when its `post-checkout` hook fails: only a cancel abandons it.
#[tokio::test]
async fn a_failed_post_checkout_hook_keeps_the_checkout_and_its_files() {
    use conn_vcs::setup::{self, ProvisionError, ProvisionRequest, WorktreeSetups};
    use std::os::unix::fs::PermissionsExt;

    let fx = Fixture::new("hook-fails");
    let hook = fx.work.join(".git/hooks/post-checkout");
    std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
    std::fs::write(&hook, "#!/bin/sh\necho kept > hook-notes.txt\nexit 1\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let setups = WorktreeSetups::new();
    let result = setup::provision(
        &setups,
        ProvisionRequest {
            thread_id: "hook".into(),
            project_root: fx.work.clone(),
            base_ref: "main".into(),
            branch: Some("feature-hook".into()),
            start_from_origin: false,
            missing_base: conn_vcs::setup::MissingBase::Fail,
            submodules: None,
            setup: None,
            worktrees_dir: fx.root.path().join("worktrees"),
        },
    )
    .await;
    assert!(
        matches!(result, Err(ProvisionError::Failed(_))),
        "{result:?}"
    );
    let path = worktree::list_worktrees(&fx.work)
        .await
        .unwrap()
        .into_iter()
        .find(|w| w.ref_name.as_deref() == Some("feature-hook"))
        .expect("the checkout was removed")
        .path;
    assert_eq!(
        std::fs::read_to_string(path.join("hook-notes.txt")).unwrap(),
        "kept\n"
    );
    assert!(
        !git(&fx.work, &["worktree", "list", "--porcelain"]).contains("locked"),
        "the kept checkout stayed locked"
    );
}

/// T3's lock reason: a cancel while Git still populates the checkout (here a slow smudge
/// filter) removes the partial checkout and its branch, so a retry can reuse the name.
#[tokio::test]
async fn a_cancel_while_git_populates_the_checkout_removes_it() {
    use conn_vcs::setup::{self, ProvisionError, ProvisionRequest, WorktreeSetups};

    let fx = Fixture::new("populating");
    write(&fx.work, ".gitattributes", "*.slow filter=slow\n");
    write(&fx.work, "big.slow", "data\n");
    commit_all(&fx.work, "slow file");
    let pid = fx.root.path().join("filter.pid");
    git(
        &fx.work,
        &[
            "config",
            "filter.slow.smudge",
            &format!("sh -c 'echo $$ > {}; sleep 31; cat'", pid.display()),
        ],
    );
    let setups = WorktreeSetups::new();
    let request = |thread: &str| ProvisionRequest {
        thread_id: thread.into(),
        project_root: fx.work.clone(),
        base_ref: "main".into(),
        branch: Some("feature-slow".into()),
        start_from_origin: false,
        missing_base: conn_vcs::setup::MissingBase::Fail,
        submodules: None,
        setup: None,
        worktrees_dir: fx.root.path().join("worktrees"),
    };
    let run = {
        let setups = setups.clone();
        let request = request("slow");
        tokio::spawn(async move { setup::provision(&setups, request).await })
    };
    read_pid(&pid).await;
    assert!(setups.cancel("slow"));
    let result = run.await.unwrap();
    assert!(
        matches!(result, Err(ProvisionError::Cancelled)),
        "{result:?}"
    );
    let left = setups.get("slow").unwrap().error;
    assert_eq!(left, None, "the cleanup left something");
    assert!(
        !git(&fx.work, &["worktree", "list", "--porcelain"]).contains("feature-slow"),
        "the partial checkout stayed registered"
    );
    assert!(
        !git(&fx.work, &["branch", "--list", "feature-slow"]).contains("feature-slow"),
        "the branch stayed"
    );
}

fn alive(pid: u32) -> bool {
    // `ps -o stat=` prints nothing for a missing process and `Z` for a zombie.
    let out = std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let stat = String::from_utf8_lossy(&out.stdout);
    !stat.trim().is_empty() && !stat.trim().starts_with('Z')
}

/// Waits up to 3 s for `pids` to end; kills the survivors either way, and returns them.
async fn survivors(pids: &[u32]) -> Vec<u32> {
    for _ in 0..60 {
        if pids.iter().all(|p| !alive(*p)) {
            return Vec::new();
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let left: Vec<u32> = pids.iter().copied().filter(|p| alive(*p)).collect();
    for pid in &left {
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status();
    }
    left
}

/// Reads a PID the script wrote, waiting up to 10 s for the file.
async fn read_pid(path: &std::path::Path) -> u32 {
    for _ in 0..200 {
        if let Some(pid) = std::fs::read_to_string(path)
            .ok()
            .and_then(|text| text.trim().parse().ok())
        {
            return pid;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("no pid in {}", path.display())
}

/// An `async` setup script (T3's default) does not hold the launch; its stage records the exit
/// when the script ends, and the setup finishes only once both it and the agent are done.
#[tokio::test]
async fn an_async_setup_script_runs_on_while_the_agent_starts() {
    use conn_contract::{
        ProjectClonePhase as Phase, WorktreeSetupStageId as Id, WorktreeSetupStageStatus as St,
    };
    use conn_vcs::setup::{self, ProvisionRequest, WorktreeSetups};
    use std::sync::Arc;

    let fx = Fixture::new("provision-async");
    let setups = WorktreeSetups::new();
    let runner = Arc::new(FakeRunner::default());
    let request = |thread: &str| ProvisionRequest {
        thread_id: thread.into(),
        project_root: fx.work.clone(),
        base_ref: "main".into(),
        branch: None,
        start_from_origin: false,
        setup: Some(runner.clone()),
        worktrees_dir: fx.root.path().join("worktrees"),
        submodules: None,
        missing_base: setup::MissingBase::Fail,
    };
    let script_stage = |thread: &str| {
        let snapshot = setups.get(thread).unwrap();
        let stage = snapshot
            .stages
            .iter()
            .find(|s| s.id == Id::SetupScript)
            .unwrap()
            .clone();
        (snapshot.phase, stage.status, stage.detail)
    };

    // The agent starts first; the script's end finishes the setup.
    let exit = runner.script(true);
    setup::provision(&setups, request("agent-first"))
        .await
        .unwrap();
    assert_eq!(
        script_stage("agent-first"),
        (Phase::Running, St::Running, None)
    );
    setups.agent_started("agent-first");
    assert_eq!(
        script_stage("agent-first").0,
        Phase::Running,
        "the setup waits for its async script"
    );
    exit.send(Some(0)).unwrap();
    settle_tasks().await;
    assert_eq!(
        script_stage("agent-first"),
        (Phase::Done, St::Done, Some("exited with 0".into()))
    );

    // The script fails before the agent starts: the launch goes on, the stage says so.
    let exit = runner.script(true);
    setup::provision(&setups, request("script-first"))
        .await
        .unwrap();
    exit.send(Some(2)).unwrap();
    settle_tasks().await;
    assert_eq!(
        script_stage("script-first"),
        (Phase::Running, St::Failed, Some("exited with 2".into()))
    );
    setups.agent_started("script-first");
    assert_eq!(script_stage("script-first").0, Phase::Done);
}

/// Cancelling while a blocking script runs ends the launch and closes the script's terminal.
#[tokio::test]
async fn cancelling_a_blocking_setup_closes_its_terminal() {
    use conn_vcs::setup::{self, ProvisionError, ProvisionRequest, WorktreeSetups};
    use std::sync::Arc;

    let fx = Fixture::new("provision-cancel");
    let setups = WorktreeSetups::new();
    let runner = Arc::new(FakeRunner::default());
    let _exit = runner.script(false);
    let request = ProvisionRequest {
        thread_id: "cancel".into(),
        project_root: fx.work.clone(),
        base_ref: "main".into(),
        branch: None,
        start_from_origin: false,
        missing_base: conn_vcs::setup::MissingBase::Fail,
        submodules: None,
        setup: Some(runner.clone()),
        worktrees_dir: fx.root.path().join("worktrees"),
    };
    let launch = {
        let setups = setups.clone();
        tokio::spawn(async move { setup::provision(&setups, request).await })
    };
    while runner.started.lock().unwrap().is_empty() {
        tokio::task::yield_now().await;
    }
    settle_tasks().await;
    assert!(setups.cancel("cancel"));
    let result = launch.await.unwrap();
    assert!(
        matches!(result, Err(ProvisionError::Cancelled)),
        "{result:?}"
    );
    assert_eq!(*runner.discarded.lock().unwrap(), ["cancel:setup-s1"]);
}

/// A cancel that arrives while the script's terminal is still being opened waits for the
/// open, then closes that terminal: no shell is left behind.
#[tokio::test]
async fn cancelling_while_the_setup_terminal_opens_closes_it() {
    use conn_vcs::setup::{self, ProvisionError, ProvisionRequest, WorktreeSetups};
    use std::sync::Arc;

    let fx = Fixture::new("provision-cancel-opening");
    let setups = WorktreeSetups::new();
    let runner = Arc::new(FakeRunner::default());
    let _exit = runner.script(false);
    let opening = runner.hold_opening();
    let request = ProvisionRequest {
        thread_id: "opening".into(),
        project_root: fx.work.clone(),
        base_ref: "main".into(),
        branch: None,
        start_from_origin: false,
        missing_base: conn_vcs::setup::MissingBase::Fail,
        submodules: None,
        setup: Some(runner.clone()),
        worktrees_dir: fx.root.path().join("worktrees"),
    };
    let launch = {
        let setups = setups.clone();
        tokio::spawn(async move { setup::provision(&setups, request).await })
    };
    while runner.started.lock().unwrap().is_empty() {
        tokio::task::yield_now().await;
    }
    assert!(setups.cancel("opening"));
    opening.notify_one();
    let result = launch.await.unwrap();
    assert!(
        matches!(result, Err(ProvisionError::Cancelled)),
        "{result:?}"
    );
    assert_eq!(*runner.discarded.lock().unwrap(), ["opening:setup-s1"]);
    assert_eq!(git(&fx.work, &["branch", "--list", "t3/*"]).trim(), "");
}

#[tokio::test]
async fn worktree_base_fetch_skips_tags_and_deleted_tracking_refs() {
    let fx = Fixture::new("handoff-base");
    git(&fx.work, &["tag", "handoff-tag"]);
    git(&fx.work, &["push", "-q", "origin", "handoff-tag"]);
    git(&fx.work, &["tag", "-d", "handoff-tag"]);
    let base = conn_vcs::setup::fetch_base(&fx.work, "main")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(base.1, "origin/main");
    assert_eq!(git(&fx.work, &["tag", "--list", "handoff-tag"]).trim(), "");
    git(&fx.origin, &["update-ref", "-d", "refs/heads/main"]);
    assert!(
        conn_vcs::setup::fetch_base(&fx.work, "main")
            .await
            .unwrap()
            .is_none()
    );
    for name in ["origin/HEAD", "HEAD~1", "main^", "@{-1}", "-", ":/fix"] {
        assert!(
            conn_vcs::setup::fetch_base(&fx.work, name)
                .await
                .unwrap()
                .is_none(),
            "{name}"
        );
    }
}

#[tokio::test]
async fn commits_selected_paths_without_staged_bystanders() {
    let fx = Fixture::new("commit-selected");
    git(&fx.work, &["config", "user.name", "test"]);
    git(&fx.work, &["config", "user.email", "test@example.com"]);
    write(&fx.work, "README.md", "changed\n");
    write(&fx.work, "other", "keep staged\n");
    write(&fx.work, "-option", "literal\n");
    git(&fx.work, &["add", "other"]);
    let paths = vec!["README.md".into(), "-option".into()];
    let context = commit::prepare_context(&fx.work, Some(&paths), true)
        .await
        .unwrap()
        .unwrap();
    assert!(context.summary.contains("README.md"));
    assert!(!context.summary.contains("other"));
    assert_eq!(
        git(&fx.work, &["diff", "--cached", "--name-only"]).trim(),
        "other"
    );
    let sha = commit::create(&fx.work, "Selected changes", "Body", Some(&paths))
        .await
        .unwrap();
    assert_eq!(sha, git(&fx.work, &["rev-parse", "HEAD"]).trim());
    assert_eq!(
        git(&fx.work, &["show", "--format=", "--name-only", "HEAD"]).trim(),
        "-option\nREADME.md"
    );
    assert!(
        commit::prepare_context(&fx.work, Some(&paths), true)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn all_files_commit_and_clean_repositories_skip() {
    let fx = Fixture::new("commit-all");
    assert!(
        commit::prepare_context(&fx.work, None, true)
            .await
            .unwrap()
            .is_none()
    );
    write(&fx.work, "new", "new\n");
    let objects = git(&fx.work, &["count-objects", "-v"]);
    assert!(
        commit::prepare_context(&fx.work, None, true)
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(git(&fx.work, &["count-objects", "-v"]), objects);
    assert!(git(&fx.work, &["diff", "--cached", "--name-only"]).is_empty());
    git(&fx.work, &["config", "user.name", "test"]);
    git(&fx.work, &["config", "user.email", "test@example.com"]);
    commit::create(&fx.work, "All changes", "", None)
        .await
        .unwrap();
    assert!(
        commit::prepare_context(&fx.work, None, true)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn partial_commit_does_not_clear_merge_state() {
    let fx = Fixture::new("commit-merge");
    git(&fx.work, &["config", "user.name", "test"]);
    git(&fx.work, &["config", "user.email", "test@example.com"]);
    let head = git(&fx.work, &["rev-parse", "HEAD"]);
    let merge = fx.work.join(".git/MERGE_HEAD");
    std::fs::write(&merge, head).unwrap();
    write(&fx.work, "README.md", "resolved\n");
    let selected = vec!["README.md".into()];
    assert!(
        commit::prepare_context(&fx.work, Some(&selected), true)
            .await
            .unwrap()
            .is_some()
    );
    assert!(merge.exists());
    let err = commit::create(&fx.work, "Partial", "", Some(&selected))
        .await
        .unwrap_err();
    assert!(
        err.to_string()
            .contains("Cannot commit selected files during a merge")
    );
    assert!(merge.exists());
    let base = git(&fx.work, &["rev-parse", "HEAD:README.md"]);
    let info = format!(
        "100644 {} 1\tREADME.md\n100644 {} 2\tREADME.md\n100644 {} 3\tREADME.md\n",
        base.trim(),
        base.trim(),
        base.trim()
    );
    let feed = fx.work.join("stages");
    std::fs::write(&feed, info).unwrap();
    let script = format!("git update-index --index-info < '{}'", feed.display());
    assert!(
        std::process::Command::new("sh")
            .args(["-c", &script])
            .current_dir(&fx.work)
            .status()
            .unwrap()
            .success()
    );
    std::fs::remove_file(feed).unwrap();
    write(
        &fx.work,
        "README.md",
        "<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n",
    );
    assert!(
        commit::prepare_context(&fx.work, None, true)
            .await
            .unwrap_err()
            .to_string()
            .contains("unresolved merge conflicts")
    );
    write(&fx.work, "README.md", "Heading\n=======\nresolved\n");
    assert!(
        commit::prepare_context(&fx.work, None, true)
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn commit_preparation_truncates_large_diffs_and_does_not_run_textconv() {
    let fx = Fixture::new("commit-large");
    write(
        &fx.work,
        "large.txt",
        &"a line of text for a generated commit message\n".repeat(30_000),
    );
    write(&fx.work, ".gitattributes", "large.txt diff=external\n");
    let context = commit::prepare_context(&fx.work, None, true)
        .await
        .unwrap()
        .unwrap();
    assert!(context.patch.ends_with("\n\n[truncated]"));
    git(&fx.work, &["config", "diff.external.textconv", "false"]);
    let context = commit::prepare_context(&fx.work, None, true)
        .await
        .unwrap()
        .unwrap();
    assert!(context.patch.len() <= 49_000 + "\n\n[truncated]".len());
    assert!(context.patch.ends_with("\n\n[truncated]"));
    assert!(context.patch.contains("+a line of text"));
}

/// T3 `GitVcsDriverCore.createWorktree` with `worktreeSparsePatternsPath`: the patterns file
/// named by `t3.json` at the ref limits the checkout; a missing one fails with nothing left.
#[tokio::test]
async fn a_sparse_worktree_leaves_out_what_t3_json_excludes() {
    let fx = Fixture::new("sparse");
    let dir = fx.root.path().join("worktrees");
    write(&fx.work, "patterns", "/*\n!/excluded/\n");
    write(&fx.work, "excluded/asset", "omitted by design\n");
    write(
        &fx.work,
        "t3.json",
        r#"{"worktreeSparsePatternsPath":"./patterns"}"#,
    );
    commit_all(&fx.work, "sparse checkout");
    let create = |branch: &str| {
        let input = CreateWorktree {
            cwd: fx.work.clone(),
            ref_name: "HEAD".into(),
            new_ref_name: Some(branch.into()),
            base_ref_name: None,
            worktrees_dir: dir.clone(),
        };
        async move { worktree::create_worktree(&input).await }
    };
    let sparse = create("probe-sparse").await.unwrap().path;
    assert!(!sparse.join("excluded/asset").exists());
    assert!(sparse.join("README.md").exists() && sparse.join("src/lib.rs").exists());

    // `parseT3ProjectFile` is lenient JSON: comments and trailing commas are fine.
    write(
        &fx.work,
        "t3.json",
        "{\n  // keep assets out\n  \"worktreeSparsePatternsPath\": \"./patterns\",\n}\n",
    );
    commit_all(&fx.work, "jsonc t3.json");
    let jsonc = create("probe-jsonc").await.unwrap().path;
    assert!(!jsonc.join("excluded/asset").exists());

    // One invalid field rejects the whole file, so the checkout is full.
    write(
        &fx.work,
        "t3.json",
        r#"{"worktreeSparsePatternsPath":"./patterns","worktreeSubmodules":"bogus"}"#,
    );
    commit_all(&fx.work, "invalid t3.json");
    let full = create("probe-invalid").await.unwrap().path;
    assert!(full.join("excluded/asset").exists());

    write(
        &fx.work,
        "t3.json",
        r#"{"worktreeSparsePatternsPath":"missing"}"#,
    );
    commit_all(&fx.work, "missing patterns");
    let error = create("probe-missing").await.unwrap_err();
    assert!(
        error
            .to_string()
            .contains("\"missing\", which is not a file in HEAD"),
        "{error}"
    );
    assert!(
        git(&fx.work, &["branch", "--list", "probe-missing"])
            .trim()
            .is_empty()
    );
}

/// `resolveProjectFileBackedSetting("worktreeSubmodules", …)`: the setting, else `t3.json` at
/// `HEAD` (even when sparse patterns leave it out), else recursive; nothing without
/// `.gitmodules`. `none` leaves the module empty.
#[tokio::test]
async fn submodule_mode_follows_the_setting_then_t3_json() {
    let fx = Fixture::new("submodule-mode");
    let mode = |setting: Option<&'static str>| {
        let work = fx.work.clone();
        async move { worktree::submodule_mode(&work, setting).await }
    };
    assert_eq!(mode(None).await, None, "no .gitmodules");
    write(
        &fx.work,
        ".gitmodules",
        "[submodule \"module\"]\n\tpath = module\n\turl = ../child\n",
    );
    commit_all(&fx.work, "gitmodules");
    use worktree::{Origin, Submodules};
    assert_eq!(
        mode(None).await,
        Some((Submodules::Recursive, Origin::Settings))
    );
    write(&fx.work, "t3.json", r#"{"worktreeSubmodules":"top-level"}"#);
    commit_all(&fx.work, "t3.json");
    // Read from HEAD: the working copy may lack it.
    std::fs::remove_file(fx.work.join("t3.json")).unwrap();
    assert_eq!(
        mode(None).await,
        Some((Submodules::TopLevel, Origin::ProjectFile))
    );
    assert_eq!(
        mode(Some("none")).await,
        Some((Submodules::None, Origin::Settings))
    );
    assert_eq!(
        mode(Some("recursive")).await,
        Some((Submodules::Recursive, Origin::Settings))
    );
    write(
        &fx.work,
        "t3.json",
        "{\n  /* a setup script fills it */\n  \"worktreeSubmodules\": \"none\",\n}\n",
    );
    commit_all(&fx.work, "jsonc t3.json");
    assert_eq!(
        mode(None).await,
        Some((Submodules::None, Origin::ProjectFile))
    );
    // A repeated key takes its last value, as `JSON.parse` does.
    write(
        &fx.work,
        "t3.json",
        r#"{"worktreeSubmodules":"recursive","worktreeSubmodules":"top-level"}"#,
    );
    commit_all(&fx.work, "repeated key");
    assert_eq!(
        mode(None).await,
        Some((Submodules::TopLevel, Origin::ProjectFile))
    );
    write(
        &fx.work,
        "t3.json",
        r#"{"worktreeSubmodules":"none","scripts":[{"name":" ","command":"x"}]}"#,
    );
    commit_all(&fx.work, "invalid t3.json");
    assert_eq!(
        mode(None).await,
        Some((Submodules::Recursive, Origin::Settings))
    );
    worktree::update_submodules(&fx.work, Submodules::None)
        .await
        .unwrap();
    assert!(!fx.work.join("module").exists());
}

/// A fixed [`hub::RemotePolicy`] the test changes between refreshes.
struct FixedPolicy(std::sync::Mutex<hub::RemotePolicy>);

impl hub::RemotePolicySource for FixedPolicy {
    fn policy<'a>(
        &'a self,
        _cwds: &'a [String],
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = hub::RemotePolicy> + Send + 'a>> {
        let policy = *self.0.lock().unwrap();
        Box::pin(async move { policy })
    }
}

/// T3 `VcsStatusBroadcaster.refreshStatus` with `VcsAutomaticFetchInterval` and
/// `maybeAutoPull`: a zero interval fetches nothing; an automatic pull fast-forwards only a
/// clean default branch that is behind and not ahead.
#[tokio::test]
async fn refresh_follows_the_fetch_interval_and_auto_pull() {
    let fx = Fixture::new("auto-pull");
    let other = fx.other_clone();
    git(&other, &["config", "user.name", "test"]);
    git(&other, &["config", "user.email", "test@example.com"]);
    write(&other, "upstream.txt", "from upstream\n");
    let upstream = commit_all(&other, "upstream");
    git(&other, &["push", "-q", "origin", "main"]);
    let before = git(&fx.work, &["rev-parse", "HEAD"]).trim().to_owned();
    let tracking = || {
        git(&fx.work, &["rev-parse", "refs/remotes/origin/main"])
            .trim()
            .to_owned()
    };
    let head = || git(&fx.work, &["rev-parse", "HEAD"]).trim().to_owned();

    let policy = std::sync::Arc::new(FixedPolicy(std::sync::Mutex::new(hub::RemotePolicy {
        fetch_interval: std::time::Duration::ZERO,
        auto_pull: true,
        background: true,
    })));
    let vcs = VcsHub::new();
    vcs.set_policy(policy.clone());
    let cwd = fx.cwd();
    let refresh = || vcs.refresh_status(&cwd, hub::Remote::Read);

    // Fetching off: the tracking ref stays, so nothing justifies a pull.
    refresh().await.unwrap();
    assert_eq!(tracking(), before);
    assert_eq!(head(), before);

    // Fetching on, but the default branch has local changes: fetched, not pulled.
    *policy.0.lock().unwrap() = hub::RemotePolicy {
        fetch_interval: std::time::Duration::from_secs(30),
        auto_pull: true,
        background: true,
    };
    write(&fx.work, "README.md", "# edited\n");
    let dirty = refresh().await.unwrap();
    assert_eq!(tracking(), upstream);
    assert_eq!(head(), before);
    assert_eq!(dirty.behind_count, 1);
    let readme = || std::fs::read_to_string(fx.work.join("README.md")).unwrap();
    assert_eq!(readme(), "# edited\n", "local changes survive");

    // Diverged: ahead and behind, so no pull.
    let local = commit_all(&fx.work, "local");
    refresh().await.unwrap();
    assert_eq!(head(), local);
    assert_eq!(readme(), "# edited\n", "the local commit survives");

    // Clean and only behind: fast-forwarded, and the result says so.
    git(&fx.work, &["reset", "-q", "--hard", &before]);
    let pulled = refresh().await.unwrap();
    assert_eq!(head(), upstream);
    assert_eq!((pulled.behind_count, pulled.ahead_count), (0, 0));
    assert_eq!(
        std::fs::read_to_string(fx.work.join("upstream.txt")).unwrap(),
        "from upstream\n"
    );

    // Automatic pull off: a later upstream commit is fetched but not pulled.
    *policy.0.lock().unwrap() = hub::RemotePolicy {
        fetch_interval: std::time::Duration::from_secs(30),
        auto_pull: false,
        background: true,
    };
    git(&fx.work, &["reset", "-q", "--hard", &before]);
    refresh().await.unwrap();
    assert_eq!(head(), before);

    // Fetching off leaves a refresh alone, but an explicit pull still fetches and moves.
    write(&other, "later.txt", "later\n");
    let later = commit_all(&other, "later");
    git(&other, &["push", "-q", "origin", "main"]);
    *policy.0.lock().unwrap() = hub::RemotePolicy {
        fetch_interval: std::time::Duration::ZERO,
        auto_pull: true,
        background: true,
    };
    refresh().await.unwrap();
    assert_eq!(tracking(), upstream);
    refs::pull(&fx.work).await.unwrap();
    assert_eq!((tracking(), head()), (later.clone(), later));
}

/// A policy the test answers per poll, with the raw folders the poll asked for.
type PolicyAsk = (Vec<String>, tokio::sync::oneshot::Sender<hub::RemotePolicy>);
struct AskedPolicy(tokio::sync::mpsc::UnboundedSender<PolicyAsk>);

impl hub::RemotePolicySource for AskedPolicy {
    fn policy<'a>(
        &'a self,
        cwds: &'a [String],
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = hub::RemotePolicy> + Send + 'a>> {
        let (reply, answer) = tokio::sync::oneshot::channel();
        let _ = self.0.send((cwds.to_vec(), reply));
        Box::pin(async move { answer.await.unwrap_or_default() })
    }
}

/// `makeRemoteRefreshLoop`: after the first read, a poll reads nothing while fetching is off
/// or no client lease lets `vcs-status` work run (`shouldRunScopeWork`); the policy sees
/// the folder as the subscriber gave it.
#[tokio::test]
async fn the_remote_poll_waits_for_fetching_and_client_activity() {
    let fx = Fixture::new("poll-gate");
    let other = fx.other_clone();
    git(&other, &["config", "user.name", "test"]);
    git(&other, &["config", "user.email", "test@example.com"]);
    let before = git(&fx.work, &["rev-parse", "HEAD"]).trim().to_owned();
    let tracking = || {
        git(&fx.work, &["rev-parse", "refs/remotes/origin/main"])
            .trim()
            .to_owned()
    };
    let head = || git(&fx.work, &["rev-parse", "HEAD"]).trim().to_owned();
    let (asks, mut asked) = tokio::sync::mpsc::unbounded_channel();
    let vcs = VcsHub::new();
    vcs.set_policy(std::sync::Arc::new(AskedPolicy(asks)));
    let cwd = format!("{}/./", fx.cwd());
    let (sink, mut events) = tokio::sync::mpsc::channel(64);
    vcs.subscribe_status(&cwd, hub::Remote::Read, Box::new(sink))
        .await
        .unwrap();
    let policy = |fetch_ms: u64, auto_pull: bool, background: bool| hub::RemotePolicy {
        fetch_interval: std::time::Duration::from_millis(fetch_ms),
        auto_pull,
        background,
    };
    // Each ask starts a poll, so it also means the poll before it has ended.
    let mut ask = async || {
        let (cwds, reply) = asked.recv().await.unwrap();
        assert_eq!(cwds, std::slice::from_ref(&cwd));
        reply
    };
    let remote_events = |events: &mut tokio::sync::mpsc::Receiver<_>| {
        std::iter::from_fn(|| events.try_recv().ok())
            .filter(|e| matches!(e, conn_contract::VcsStatusStreamEvent::RemoteUpdated(_)))
            .count()
    };

    // The first read runs paused: it has nothing yet.
    ask().await.send(policy(10, false, false)).unwrap();
    let reply = ask().await;
    write(&other, "upstream.txt", "from upstream\n");
    let upstream = commit_all(&other, "upstream");
    git(&other, &["push", "-q", "origin", "main"]);
    // Behind already, so only a pull or a read could change anything.
    git(&fx.work, &["fetch", "-q", "origin"]);
    assert_eq!(tracking(), upstream);
    let _ = remote_events(&mut events);

    // Paused: no pull, no read.
    reply.send(policy(10, true, false)).unwrap();
    let reply = ask().await;
    assert_eq!(head(), before, "no pull while paused");
    assert_eq!(remote_events(&mut events), 0, "no read while paused");

    // Fetching off: not even the cached refs are read.
    reply.send(policy(0, true, true)).unwrap();
    let reply = ask().await;
    assert_eq!(remote_events(&mut events), 0, "no read with fetching off");
    assert_eq!(head(), before);

    // Active and fetching: the poll pulls.
    reply.send(policy(10, true, true)).unwrap();
    let reply = ask().await;
    assert_eq!(head(), upstream);

    // `reconcileCheckedOutRef`: a terminal checkout rereads remote status while paused, but
    // fetches nothing and pulls nothing, even onto a clean default branch that is behind.
    write(&other, "second.txt", "second\n");
    let second = commit_all(&other, "second");
    git(&other, &["push", "-q", "origin", "main"]);
    git(&fx.work, &["fetch", "-q", "origin"]);
    write(&other, "third.txt", "third\n");
    commit_all(&other, "third");
    git(&other, &["push", "-q", "origin", "main"]);
    reply.send(policy(10, true, false)).unwrap();
    tokio::spawn(async move {
        while let Some((_, reply)) = asked.recv().await {
            let _ = reply.send(policy(10, true, false));
        }
    });
    let mut switch_to = async |branch: &str, args: &[&str]| {
        git(&fx.work, args);
        let mut switched = false;
        while let Some(event) = events.recv().await {
            match event {
                conn_contract::VcsStatusStreamEvent::LocalUpdated(e) => {
                    switched |= e.local.ref_name.as_deref() == Some(branch);
                }
                conn_contract::VcsStatusStreamEvent::RemoteUpdated(e)
                    if switched && e.remote.is_some() =>
                {
                    return;
                }
                _ => {}
            }
        }
    };
    switch_to("side", &["checkout", "-q", "-b", "side"]).await;
    switch_to("main", &["checkout", "-q", "main"]).await;
    assert_eq!(
        tracking(),
        second,
        "no fetch on a branch switch while paused"
    );
    assert_eq!(head(), upstream, "no pull on a branch switch while paused");
}

/// A restore clears only its own stale registration: another worktree whose folder is away
/// (an unmounted drive) keeps its metadata, which a repository-wide `git worktree prune`
/// would delete.
#[tokio::test]
async fn a_restore_keeps_other_missing_worktrees_registered() {
    let root = TempDir::new("restore-scoped");
    let project = root.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    git(&project, &["init", "-q", "-b", "main"]);
    git(&project, &["commit", "-q", "--allow-empty", "-m", "base"]);
    let ours = root.path().join("worktrees/project/ours");
    let away = root.path().join("drive/away");
    for (branch, path) in [("ours", &ours), ("away", &away)] {
        git(
            &project,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                branch,
                path.to_str().unwrap(),
            ],
        );
    }
    std::fs::remove_dir_all(&ours).unwrap();
    std::fs::remove_dir_all(root.path().join("drive")).unwrap();
    assert!(
        worktree::restore_missing_worktree(&project, &ours, "ours")
            .await
            .unwrap()
    );
    assert_eq!(git(&ours, &["branch", "--show-current"]).trim(), "ours");
    let list = git(&project, &["worktree", "list", "--porcelain"]);
    assert!(
        list.contains("branch refs/heads/away"),
        "the unmounted worktree stays registered: {list}"
    );
}

/// T3 `ProviderTurnStartService.test.ts` "recovers the local or pushed thread tip, else the
/// current branch, remote default, or detached HEAD", through `restore_missing_worktree`.
#[tokio::test]
async fn a_missing_worktree_is_restored_from_its_surviving_tip() {
    let root = TempDir::new("restore");
    let project = root.path().join("project");
    let origin = root.path().join("origin.git");
    let path = root.path().join("worktrees/project/restore");
    std::fs::create_dir_all(&project).unwrap();
    git(
        root.path(),
        &[
            "init",
            "-q",
            "--bare",
            "-b",
            "main",
            origin.to_str().unwrap(),
        ],
    );
    git(&project, &["init", "-q", "-b", "main"]);
    git(&project, &["commit", "-q", "--allow-empty", "-m", "base"]);
    let base_tip = git(&project, &["rev-parse", "HEAD"]).trim().to_owned();
    git(
        &project,
        &["remote", "add", "origin", origin.to_str().unwrap()],
    );
    git(&project, &["push", "-q", "origin", "main"]);
    git(&project, &["remote", "set-head", "origin", "main"]);
    git(
        &project,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feature/restore",
            path.to_str().unwrap(),
        ],
    );
    write(&path, "thread.txt", "thread work");
    let thread_tip = commit_all(&path, "thread tip");
    git(&project, &["switch", "-q", "-c", "project-current"]);
    write(&project, "project.txt", "new project code");
    let project_tip = commit_all(&project, "project tip");
    // Tags must neither hide the thread branch nor select a different tip.
    git(&project, &["tag", "feature/restore", &project_tip]);
    git(&project, &["tag", "project-current", &thread_tip]);
    git(&project, &["tag", "origin/feature/restore", &thread_tip]);
    let config = |key: &str| {
        std::process::Command::new("git")
            .args(["-C", project.to_str().unwrap(), "config", "--get"])
            .arg(format!("branch.feature/restore.{key}"))
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
            .unwrap()
    };
    /// (scenario, tip, file, upstream, recorded base)
    type Case<'a> = (&'a str, &'a str, Option<&'a str>, Option<&'a str>, &'a str);
    let cases: [Case<'_>; 8] = [
        ("retained", &thread_tip, Some("thread.txt"), None, ""),
        ("leftover", &thread_tip, Some("thread.txt"), None, ""),
        (
            "deleted",
            &project_tip,
            Some("project.txt"),
            None,
            "project-current",
        ),
        (
            "pushed",
            &thread_tip,
            Some("thread.txt"),
            Some("refs/remotes/origin/feature/restore"),
            "",
        ),
        (
            "pushed-detached",
            &thread_tip,
            Some("thread.txt"),
            Some("refs/remotes/origin/feature/restore"),
            "",
        ),
        (
            "pushed-sole-remote",
            &thread_tip,
            Some("thread.txt"),
            Some("refs/remotes/upstream/feature/restore"),
            "",
        ),
        ("detached", &base_tip, None, None, "main"),
        (
            "detached-no-remote",
            &project_tip,
            Some("project.txt"),
            None,
            "",
        ),
    ];
    for (scenario, tip, file, upstream, base) in cases {
        match scenario {
            "pushed" => {
                git(
                    &project,
                    &[
                        "push",
                        "-q",
                        "origin",
                        &format!("{thread_tip}:refs/heads/feature/restore"),
                    ],
                );
                git(&project, &["fetch", "-q", "origin"]);
            }
            "pushed-detached" => {
                git(&project, &["switch", "-q", "--detach"]);
            }
            "pushed-sole-remote" => {
                git(&project, &["remote", "rename", "origin", "upstream"]);
            }
            "detached" => {
                git(&project, &["remote", "rename", "upstream", "origin"]);
                git(
                    &project,
                    &["push", "-q", "origin", "--delete", "feature/restore"],
                );
            }
            "detached-no-remote" => {
                git(&project, &["remote", "remove", "origin"]);
            }
            _ => {}
        }
        std::fs::remove_dir_all(&path).unwrap();
        if scenario == "leftover" {
            std::fs::create_dir_all(path.join("node_modules")).unwrap();
        }
        if scenario != "retained" && scenario != "leftover" {
            git(&project, &["worktree", "prune"]);
            git(&project, &["branch", "-q", "-D", "feature/restore"]);
        }
        assert!(
            worktree::restore_missing_worktree(&project, &path, "feature/restore")
                .await
                .unwrap(),
            "{scenario}"
        );
        assert_eq!(
            git(&path, &["branch", "--show-current"]).trim(),
            "feature/restore",
            "{scenario}"
        );
        assert_eq!(git(&path, &["rev-parse", "HEAD"]).trim(), tip, "{scenario}");
        for name in ["thread.txt", "project.txt"] {
            assert_eq!(
                path.join(name).exists(),
                Some(name) == file,
                "{scenario} {name}"
            );
        }
        if let Some(upstream) = upstream {
            assert_eq!(
                git(&path, &["rev-parse", "--symbolic-full-name", "@{upstream}"]).trim(),
                upstream,
                "{scenario}"
            );
        } else {
            assert_eq!(config("merge"), "", "{scenario}");
        }
        assert_eq!(config("t3-merge-base"), base, "{scenario}");
    }
    // A checkout that is there, or a folder with other files, is left alone.
    assert!(
        !worktree::restore_missing_worktree(&project, &path, "feature/restore")
            .await
            .unwrap()
    );
}

/// T3's ThreadLaunchService cases for a recorded base (`worktreeFallbackBase`): a saved
/// strategy whose base names no commit starts from the remote's default branch, then the
/// checked-out branch. A base someone names now still fails.
#[tokio::test]
async fn a_saved_base_that_names_no_commit_falls_back_as_t3() {
    use conn_vcs::setup::{self, MissingBase, ProvisionError, ProvisionRequest, WorktreeSetups};

    let fx = Fixture::new("missing-base");
    let setups = WorktreeSetups::new();
    let request = |thread: &str, base: &str, missing_base| ProvisionRequest {
        thread_id: thread.into(),
        project_root: fx.work.clone(),
        base_ref: base.into(),
        branch: Some(format!("task-{thread}")),
        start_from_origin: true,
        setup: None,
        worktrees_dir: fx.root.path().join("worktrees"),
        submodules: None,
        missing_base,
    };
    let remote_head = git(&fx.work, &["rev-parse", "origin/main"])
        .trim()
        .to_owned();
    git(&fx.work, &["checkout", "-q", "--detach"]);
    git(
        &fx.work,
        &["commit", "-q", "--allow-empty", "-m", "local only"],
    );
    let local_head = git(&fx.work, &["rev-parse", "HEAD"]).trim().to_owned();

    // "re-bases a stored base that no longer exists on the remote default branch"
    let made = setup::provision(
        &setups,
        request("gone", "obsolete-base", MissingBase::FallBack),
    )
    .await
    .unwrap();
    assert_eq!(git(&made.path, &["rev-parse", "HEAD"]).trim(), remote_head);
    assert_eq!(
        setups.get("gone").unwrap().base_ref.as_deref(),
        Some("refs/remotes/origin/main")
    );

    // The same base named in a new launch is refused, and nothing is left behind.
    let refused = setup::provision(
        &setups,
        request("asked", "obsolete-base", MissingBase::Fail),
    )
    .await
    .unwrap_err();
    assert!(matches!(refused, ProvisionError::Failed(_)), "{refused}");
    assert!(git(&fx.work, &["branch", "--list", "task-asked"]).is_empty());

    // A base that resolves is kept, a local branch and a `:/` commit search alike.
    git(&fx.work, &["branch", "kept"]);
    for (thread, base) in [("kept", "kept"), ("search", ":/local only")] {
        let made = setup::provision(&setups, request(thread, base, MissingBase::FallBack))
            .await
            .unwrap();
        assert_eq!(
            git(&made.path, &["rev-parse", "HEAD"]).trim(),
            local_head,
            "{base}"
        );
    }

    // "skips a stale tracking ref when the remote reports the base branch is gone": the
    // remote's HEAD names a deleted branch whose tracking ref stayed behind.
    git(
        &fx.work,
        &["update-ref", "refs/remotes/origin/gone", &remote_head],
    );
    git(
        &fx.work,
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/gone",
        ],
    );
    git(&fx.work, &["checkout", "-q", "-b", "beta"]);
    let made = setup::provision(
        &setups,
        request("stale", "obsolete-base", MissingBase::FallBack),
    )
    .await
    .unwrap();
    assert_eq!(git(&made.path, &["rev-parse", "HEAD"]).trim(), local_head);
    assert_eq!(
        setups.get("stale").unwrap().base_ref.as_deref(),
        Some("beta")
    );

    // A dangling `origin/HEAD`: it names `origin/next`, which the remote has but this clone
    // never fetched. Git's `rev-parse` refuses it (`resolveDefaultBranchName`), so the
    // checked-out commit is used, not the remote's `next`.
    let remote_next = git(
        &fx.work,
        &[
            "commit-tree",
            "HEAD^{tree}",
            "-p",
            &remote_head,
            "-m",
            "next",
        ],
    )
    .trim()
    .to_owned();
    git(
        &fx.work,
        &[
            "push",
            "-q",
            "origin",
            &format!("{remote_next}:refs/heads/next"),
        ],
    );
    git(&fx.work, &["update-ref", "-d", "refs/remotes/origin/next"]);
    git(
        &fx.work,
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/next",
        ],
    );
    let made = setup::provision(
        &setups,
        request("dangling", "obsolete-base", MissingBase::FallBack),
    )
    .await
    .unwrap();
    assert_eq!(git(&made.path, &["rev-parse", "HEAD"]).trim(), local_head);
    assert_eq!(
        setups.get("dangling").unwrap().base_ref.as_deref(),
        Some("beta")
    );
}

/// The checkout probes ask the filesystem off the runtime thread: with the one blocking
/// thread held, a probe of a missing folder cannot answer at its first poll.
#[test]
fn checkout_probes_stat_off_the_runtime_thread() {
    use std::{
        future::Future,
        task::{Context, Waker},
    };

    let runtime = tokio::runtime::Builder::new_current_thread()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    let dir = TempDir::new("blocking");
    let missing = dir.path().join("missing");
    runtime.block_on(async {
        let (release, held) = std::sync::mpsc::channel::<()>();
        let (started, running) = tokio::sync::oneshot::channel();
        let blocker = tokio::task::spawn_blocking(move || {
            let _ = started.send(());
            let _ = held.recv();
        });
        running.await.unwrap();

        let mut cx = Context::from_waker(Waker::noop());
        let mut branch = std::pin::pin!(conn_vcs::repo::current_branch(&missing));
        let mut commit = std::pin::pin!(conn_vcs::repo::resolve_commit(&missing, "HEAD"));
        assert!(
            branch.as_mut().poll(&mut cx).is_pending(),
            "current_branch stats on the runtime thread"
        );
        assert!(
            commit.as_mut().poll(&mut cx).is_pending(),
            "resolve_commit stats on the runtime thread"
        );
        release.send(()).unwrap();
        blocker.await.unwrap();
        assert_eq!(branch.await.unwrap(), None);
        assert_eq!(commit.await.unwrap(), None);
    });
}

/// The Git settings a project can carry that change what a plain `git diff` reports.
const DIFF_SETTINGS: [&[(&str, &str)]; 3] = [
    &[],
    &[("diff.relative", "true")],
    &[("diff.relative", "true"), ("color.ui", "always")],
];

fn configure(work: &std::path::Path, settings: &[(&str, &str)]) {
    for (key, value) in settings {
        git(work, &["config", key, value]);
    }
}

/// `notes.txt` at the root conflicts in a merge from `feature`; `sub/` is the project folder.
fn merge_conflict(label: &str) -> Fixture {
    conflict_in(label, "notes.txt", |_| {})
}

/// `file` at the root conflicts in a merge from `feature`. `prepare` runs on the work tree
/// before the base commit, so it can add `.gitattributes` or Git settings.
fn conflict_in(label: &str, file: &str, prepare: impl FnOnce(&std::path::Path)) -> Fixture {
    conflict_between(label, file, ["base\n", "feature\n", "main\n"], prepare)
}

/// `file` holds `base`, then `feature` on that branch and `main` on `main`, which merges
/// `feature` with a conflict.
fn conflict_between(
    label: &str,
    file: &str,
    [base, feature, main]: [&str; 3],
    prepare: impl FnOnce(&std::path::Path),
) -> Fixture {
    let fx = Fixture::new(label);
    prepare(&fx.work);
    write(&fx.work, file, base);
    write(&fx.work, "sub/chosen.txt", "one\n");
    commit_all(&fx.work, "base");
    git(&fx.work, &["checkout", "-q", "-b", "feature"]);
    write(&fx.work, file, feature);
    commit_all(&fx.work, "feature");
    git(&fx.work, &["checkout", "-q", "main"]);
    write(&fx.work, file, main);
    commit_all(&fx.work, "main");
    let merge = std::process::Command::new("git")
        .args(["merge", "feature"])
        .current_dir(&fx.work)
        .output()
        .unwrap();
    assert!(!merge.status.success(), "the merge should conflict");
    fx
}

// T3: "keeps other files conflicted through a selected-file commit", run from a nested project
// folder under each diff setting.
#[tokio::test]
async fn keeps_other_files_conflicted_through_a_selected_file_commit() {
    for settings in DIFF_SETTINGS {
        let fx = Fixture::new("commit-stash-pop");
        write(&fx.work, "notes.txt", "base\n");
        write(&fx.work, "sub/chosen.txt", "one\n");
        commit_all(&fx.work, "base");
        // git stash pop leaves notes.txt conflicted with no merge in progress.
        write(&fx.work, "notes.txt", "stashed version\n");
        git(&fx.work, &["stash", "-q"]);
        write(&fx.work, "notes.txt", "committed version\n");
        commit_all(&fx.work, "change notes");
        let pop = std::process::Command::new("git")
            .args(["stash", "pop"])
            .current_dir(&fx.work)
            .output()
            .unwrap();
        assert!(!pop.status.success(), "the stash pop should conflict");
        configure(&fx.work, settings);
        write(&fx.work, "sub/chosen.txt", "one\ntwo\n");
        // A formatting hook stages its edit into the temporary index that --only commits from.
        write(
            &fx.work,
            ".git/hooks/pre-commit",
            "#!/bin/sh\necho formatted >> sub/chosen.txt\ngit add sub/chosen.txt\n",
        );
        let hook = fx.work.join(".git/hooks/pre-commit");
        let mut mode = std::fs::metadata(&hook).unwrap().permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut mode, 0o755);
        std::fs::set_permissions(&hook, mode).unwrap();
        let head = git(&fx.work, &["rev-parse", "HEAD"]);
        let unmerged = git(&fx.work, &["ls-files", "--unmerged"]);
        assert_eq!(unmerged.lines().count(), 3, "{settings:?}");
        let sub = fx.work.join("sub");
        let selected = vec!["sub/chosen.txt".to_owned()];

        let context = commit::prepare_context(&sub, Some(&selected), true)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(context.summary, "M\tsub/chosen.txt", "{settings:?}");
        commit::create(&sub, "Add chosen", "", Some(&selected))
            .await
            .unwrap();

        assert_eq!(
            git(&fx.work, &["rev-parse", "HEAD~1"]),
            head,
            "{settings:?}"
        );
        assert_eq!(
            git(&fx.work, &["show", "--pretty=", "--name-only", "HEAD"]),
            "sub/chosen.txt\n"
        );
        assert_eq!(
            git(&fx.work, &["show", "HEAD:sub/chosen.txt"]),
            "one\ntwo\nformatted\n"
        );
        assert_eq!(
            git(&fx.work, &["show", ":sub/chosen.txt"]),
            "one\ntwo\nformatted\n"
        );
        assert_eq!(git(&fx.work, &["ls-files", "--unmerged"]), unmerged);
        let all = commit::prepare_context(&sub, None, true).await.unwrap_err();
        assert!(
            all.to_string().contains(
                "Cannot commit with unresolved merge conflicts in notes.txt. Resolve them, then commit."
            ),
            "{settings:?}: {all}"
        );
    }
}

#[tokio::test]
async fn commit_all_from_a_subdirectory_refuses_a_conflict_anywhere() {
    for settings in DIFF_SETTINGS {
        let fx = merge_conflict("commit-all-conflict");
        configure(&fx.work, settings);
        write(&fx.work, "sub/chosen.txt", "one\ntwo\n");
        let head = git(&fx.work, &["rev-parse", "HEAD"]);
        let stages = git(&fx.work, &["ls-files", "-s"]);
        let notes = std::fs::read(fx.work.join("notes.txt")).unwrap();
        assert!(String::from_utf8_lossy(&notes).starts_with("<<<<<<< HEAD\n"));
        let sub = fx.work.join("sub");

        let prepared = commit::prepare_context(&sub, None, true).await.unwrap_err();
        assert!(
            prepared
                .to_string()
                .contains("unresolved merge conflicts in notes.txt"),
            "{settings:?}: {prepared}"
        );
        let created = commit::create(&sub, "All", "", None).await.unwrap_err();
        assert!(
            created
                .to_string()
                .contains("unresolved merge conflicts in notes.txt"),
            "{settings:?}: {created}"
        );
        assert_eq!(git(&fx.work, &["rev-parse", "HEAD"]), head, "{settings:?}");
        assert!(fx.work.join(".git/MERGE_HEAD").exists(), "{settings:?}");
        assert_eq!(git(&fx.work, &["ls-files", "-s"]), stages, "{settings:?}");
        assert_eq!(std::fs::read(fx.work.join("notes.txt")).unwrap(), notes);

        // Once resolved, Commit All finishes the merge with both parents.
        write(&fx.work, "notes.txt", "resolved\n");
        commit::create(&sub, "Merge", "", None).await.unwrap();
        assert_eq!(
            git(&fx.work, &["rev-list", "--parents", "-n1", "HEAD"])
                .split_whitespace()
                .count(),
            3,
            "{settings:?}"
        );
        assert_eq!(git(&fx.work, &["show", "HEAD:notes.txt"]), "resolved\n");
        assert_eq!(
            git(&fx.work, &["show", "HEAD:sub/chosen.txt"]),
            "one\ntwo\n"
        );
        assert!(!fx.work.join(".git/MERGE_HEAD").exists());
    }
}

/// Commit All from `sub/` refuses `file`, and leaves HEAD, the merge, the stages and the file.
async fn assert_commit_all_refused(fx: &Fixture, file: &str) {
    let head = git(&fx.work, &["rev-parse", "HEAD"]);
    let stages = git(&fx.work, &["ls-files", "-s"]);
    let content = std::fs::read(fx.work.join(file)).unwrap();
    let sub = fx.work.join("sub");
    let expected = format!("Cannot commit with unresolved merge conflicts in {file}.");

    let prepared = commit::prepare_context(&sub, None, true).await.unwrap_err();
    assert!(prepared.to_string().contains(&expected), "{prepared}");
    let created = commit::create(&sub, "All", "", None).await.unwrap_err();
    assert!(created.to_string().contains(&expected), "{created}");

    assert_eq!(git(&fx.work, &["rev-parse", "HEAD"]), head, "HEAD moved");
    assert!(fx.work.join(".git/MERGE_HEAD").exists(), "the merge ended");
    assert_eq!(git(&fx.work, &["ls-files", "-s"]), stages, "stages changed");
    assert_eq!(
        std::fs::read(fx.work.join(file)).unwrap(),
        content,
        "the file changed"
    );
}

/// Commit All from `sub/` finishes the merge with both parents and `file` as `resolution`.
async fn assert_commit_all_merges(fx: &Fixture, file: &str, resolution: &str) {
    write(&fx.work, file, resolution);
    commit::create(&fx.work.join("sub"), "Merge", "", None)
        .await
        .unwrap();
    assert_eq!(
        git(&fx.work, &["rev-list", "--parents", "-n1", "HEAD"])
            .split_whitespace()
            .count(),
        3,
        "a merge commit has two parents"
    );
    assert_eq!(
        git(&fx.work, &["show", &format!("HEAD:{file}")]),
        resolution,
        "the committed resolution"
    );
    assert!(
        git(&fx.work, &["ls-files", "--unmerged"]).is_empty(),
        "stages remain"
    );
    assert!(
        !fx.work.join(".git/MERGE_HEAD").exists(),
        "the merge is still pending"
    );
}

/// Commit All from `sub/` commits `file` with its markers, as T3 does: its `git diff --check`
/// reports no marker in this file.
async fn assert_commit_all_keeps_markers(fx: &Fixture, file: &str) {
    let content = std::fs::read_to_string(fx.work.join(file)).unwrap();
    assert!(content.contains("<<<<<<< "), "{content}");
    assert_commit_all_merges(fx, file, &content).await;
}

#[tokio::test]
async fn commit_all_commits_markers_that_a_binary_diff_driver_hides_as_t3() {
    let fx = conflict_in("commit-binary-driver", "notes.txt", |work| {
        write(work, ".gitattributes", "*.txt diff=doc\n");
    });
    // `git diff --check` skips a file whose diff driver calls it binary.
    configure(&fx.work, &[("diff.doc.binary", "true")]);

    assert_commit_all_keeps_markers(&fx, "notes.txt").await;
}

#[tokio::test]
async fn commit_all_commits_markers_in_a_file_named_with_a_newline_as_t3() {
    let file = "odd\nname.txt";
    let fx = conflict_in("commit-newline-name", file, |_| {});

    // `git diff --check` prints the raw name, so T3's line-by-line read never matches it.
    assert_commit_all_keeps_markers(&fx, file).await;
}

#[tokio::test]
async fn commit_all_commits_a_resolution_with_a_lone_divider_line() {
    let fx = merge_conflict("commit-lone-divider");
    assert_commit_all_merges(
        &fx,
        "notes.txt",
        "Heading\n=======\n<<<<<<< only an opening\nresolved\n",
    )
    .await;
}

#[tokio::test]
async fn commit_all_keeps_markers_the_file_already_had() {
    // A file that documents conflict markers, as T3's `--check` reads only added lines.
    let example = "Example:\n<<<<<<< ours\nmine\n=======\nyours\n>>>>>>> theirs\n";
    let fx = conflict_between(
        "commit-documented-markers",
        "notes.txt",
        [
            &format!("{example}base\n"),
            &format!("{example}feature\n"),
            &format!("{example}main\n"),
        ],
        |_| {},
    );

    assert_commit_all_refused(&fx, "notes.txt").await;
    assert_commit_all_merges(&fx, "notes.txt", &format!("{example}resolved\n")).await;
}

#[tokio::test]
async fn commit_all_commits_markers_in_a_file_our_side_deleted_as_t3() {
    let fx = Fixture::new("commit-deleted-by-us");
    write(&fx.work, "notes.txt", "base\n");
    write(&fx.work, "sub/chosen.txt", "one\n");
    commit_all(&fx.work, "base");
    git(&fx.work, &["checkout", "-q", "-b", "feature"]);
    write(&fx.work, "notes.txt", "feature\n");
    commit_all(&fx.work, "feature");
    git(&fx.work, &["checkout", "-q", "main"]);
    git(&fx.work, &["rm", "-q", "notes.txt"]);
    commit_all(&fx.work, "main");
    let merge = std::process::Command::new("git")
        .args(["merge", "feature"])
        .current_dir(&fx.work)
        .output()
        .unwrap();
    assert!(!merge.status.success(), "the merge should conflict");
    let stages = git(&fx.work, &["ls-files", "--unmerged"]);
    assert!(!stages.contains(" 2\t"), "{stages}");
    write(
        &fx.work,
        "notes.txt",
        "<<<<<<< HEAD\n=======\nfeature\n>>>>>>> feature\n",
    );

    // `git diff --check` compares the file with our side, stage 2, and there is none.
    assert_commit_all_keeps_markers(&fx, "notes.txt").await;
}

#[tokio::test]
async fn commit_all_reads_markers_at_the_configured_width() {
    let fx = conflict_in("commit-marker-size", "notes.txt", |work| {
        // Anchored, so the lookup has to run from the repository root, not `sub/`.
        write(
            work,
            ".gitattributes",
            "/notes.txt conflict-marker-size=12\n",
        );
        configure(work, &[("merge.conflictStyle", "diff3")]);
    });
    let notes = std::fs::read_to_string(fx.work.join("notes.txt")).unwrap();
    assert!(notes.starts_with("<<<<<<<<<<<< HEAD\n"), "{notes}");
    assert!(notes.contains("\n|||||||||||| "), "{notes}");

    assert_commit_all_refused(&fx, "notes.txt").await;
    // Nine-wide markers are content in a file whose markers are twelve wide.
    assert_commit_all_merges(
        &fx,
        "notes.txt",
        "<<<<<<<<< ours\nexample\n=========\nexample\n>>>>>>>>> theirs\n",
    )
    .await;
}

#[tokio::test]
async fn commit_all_refuses_markers_when_another_file_fails_the_whole_tree_check() {
    let fx = conflict_in("commit-check-fatal", "z.txt", |work| {
        // Git dies on this pair, but only for a file it diffs.
        write(
            work,
            ".gitattributes",
            "a.txt whitespace=tab-in-indent,indent-with-non-tab\n",
        );
        write(work, "a.txt", "one\n");
    });
    write(&fx.work, "a.txt", "two\n");

    assert_commit_all_refused(&fx, "z.txt").await;
    assert_commit_all_merges(&fx, "z.txt", "resolved\n").await;
}

/// Runs `git merge feature` in `work` and checks that it conflicts.
fn merge_feature(work: &std::path::Path) {
    let merge = std::process::Command::new("git")
        .args(["-c", "protocol.file.allow=always", "merge", "feature"])
        .current_dir(work)
        .output()
        .unwrap();
    assert!(!merge.status.success(), "the merge should conflict");
}

#[tokio::test]
async fn commit_all_commits_a_rename_rename_conflict_as_t3() {
    let fx = Fixture::new("commit-rename-rename");
    let lines = (1..=20).map(|n| format!("{n}\n")).collect::<String>();
    write(&fx.work, "f.txt", &lines);
    write(&fx.work, "sub/chosen.txt", "one\n");
    commit_all(&fx.work, "base");
    git(&fx.work, &["checkout", "-q", "-b", "feature"]);
    git(&fx.work, &["mv", "f.txt", "g.txt"]);
    write(&fx.work, "g.txt", &lines.replace("\n10\n", "\nfeature\n"));
    commit_all(&fx.work, "feature");
    git(&fx.work, &["checkout", "-q", "main"]);
    git(&fx.work, &["mv", "f.txt", "h.txt"]);
    write(&fx.work, "h.txt", &lines.replace("\n10\n", "\nmain\n"));
    commit_all(&fx.work, "main");
    merge_feature(&fx.work);
    // Git writes the merged file, with markers one wider than the attribute, as h.txt's
    // stage 2 and g.txt's stage 3.
    let merged = std::fs::read_to_string(fx.work.join("g.txt")).unwrap();
    assert!(merged.contains("\n<<<<<<<< HEAD:h.txt\n"), "{merged}");
    assert_eq!(
        std::fs::read_to_string(fx.work.join("h.txt")).unwrap(),
        merged
    );

    // `git diff --check` reads markers at the attribute's width only, as T3 relies on.
    commit::create(&fx.work.join("sub"), "Merge", "", None)
        .await
        .unwrap();
    assert_eq!(git(&fx.work, &["show", "HEAD:g.txt"]), merged);
    assert_eq!(git(&fx.work, &["show", "HEAD:h.txt"]), merged);
    assert!(!fx.work.join(".git/MERGE_HEAD").exists());
}

#[tokio::test]
async fn commit_all_commits_default_markers_after_an_incoming_marker_size_as_t3() {
    let fx = Fixture::new("commit-incoming-attributes");
    write(&fx.work, "notes.txt", "base\n");
    write(&fx.work, "sub/chosen.txt", "one\n");
    commit_all(&fx.work, "base");
    git(&fx.work, &["checkout", "-q", "-b", "feature"]);
    write(&fx.work, "notes.txt", "feature\n");
    write(
        &fx.work,
        ".gitattributes",
        "notes.txt conflict-marker-size=12\n",
    );
    commit_all(&fx.work, "feature");
    git(&fx.work, &["checkout", "-q", "main"]);
    write(&fx.work, "notes.txt", "main\n");
    commit_all(&fx.work, "main");
    merge_feature(&fx.work);
    // Git wrote seven-wide markers; the merged attributes now say twelve.
    let notes = std::fs::read_to_string(fx.work.join("notes.txt")).unwrap();
    assert!(notes.starts_with("<<<<<<< HEAD\n"), "{notes}");
    assert_eq!(
        git(
            &fx.work,
            &["check-attr", "conflict-marker-size", "notes.txt"]
        ),
        "notes.txt: conflict-marker-size: 12\n"
    );

    // `git diff --check` reads twelve-wide markers only.
    assert_commit_all_keeps_markers(&fx, "notes.txt").await;
}

#[tokio::test]
async fn commit_all_reads_an_out_of_range_marker_size_as_the_default() {
    let fx = merge_conflict("commit-marker-size-range");
    // Past Git's `int`: Git reads it as no size, so the markers are seven wide.
    write(
        &fx.work,
        ".gitattributes",
        "notes.txt conflict-marker-size=99999999999\n",
    );

    assert_commit_all_refused(&fx, "notes.txt").await;
    assert_commit_all_merges(&fx, "notes.txt", "resolved\n").await;
}

#[tokio::test]
async fn commit_all_commits_a_submodule_resolution_under_an_inline_submodule_diff() {
    let fx = Fixture::new("commit-submodule");
    let lib = fx.root.path().join("lib");
    git(
        fx.root.path(),
        &["init", "-q", "-b", "main", lib.to_str().unwrap()],
    );
    git(&lib, &["config", "user.name", "test"]);
    git(&lib, &["config", "user.email", "test@example.com"]);
    write(&lib, "a.txt", "a\n");
    let base = commit_all(&lib, "a");
    git(
        &fx.work,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            lib.to_str().unwrap(),
            "lib",
        ],
    );
    write(&fx.work, "sub/chosen.txt", "one\n");
    commit_all(&fx.work, "base");
    let checkout = fx.work.join("lib");
    git(&fx.work, &["checkout", "-q", "-b", "feature"]);
    write(&checkout, "b.txt", "b\n");
    commit_all(&checkout, "b");
    commit_all(&fx.work, "feature");
    git(&fx.work, &["checkout", "-q", "main"]);
    git(&checkout, &["checkout", "-q", &base]);
    write(&checkout, "c.txt", "c\n");
    commit_all(&checkout, "c");
    commit_all(&fx.work, "main");
    merge_feature(&fx.work);
    assert!(git(&fx.work, &["ls-files", "--unmerged"]).contains("\tlib\n"));
    // The resolution is a submodule commit that adds a file documenting markers, which an
    // inline submodule diff would show as added lines.
    write(
        &checkout,
        "doc.txt",
        "<<<<<<< ours\n=======\n>>>>>>> theirs\n",
    );
    let resolution = commit_all(&checkout, "doc");
    configure(&fx.work, &[("diff.submodule", "diff")]);

    commit::create(&fx.work.join("sub"), "Merge", "", None)
        .await
        .unwrap();
    assert_eq!(
        git(&fx.work, &["rev-parse", "HEAD:lib"]).trim(),
        resolution,
        "the committed gitlink"
    );
    assert!(git(&fx.work, &["ls-files", "--unmerged"]).is_empty());
    assert!(!fx.work.join(".git/MERGE_HEAD").exists());
}

#[tokio::test]
async fn commit_all_commits_thousands_of_conflicts_resolved_to_ours() {
    const FILES: usize = 800;
    let fx = Fixture::new("commit-many-conflicts");
    // Deep names, so `ls-files --unmerged` prints more than 1 MB from few files: each
    // `git diff` reads the whole index, so every file adds to every other file's cost.
    let folder = "a-long-folder-name".repeat(5);
    let name = |n: usize| format!("many/{folder}/{folder}/{folder}/{folder}/{n:04}.txt");
    let write_all = |text: &str| {
        for n in 0..FILES {
            write(&fx.work, &name(n), &format!("{text} {n}\n"));
        }
    };
    write_all("base");
    write(&fx.work, "sub/chosen.txt", "one\n");
    commit_all(&fx.work, "base");
    git(&fx.work, &["checkout", "-q", "-b", "feature"]);
    write_all("feature");
    commit_all(&fx.work, "feature");
    git(&fx.work, &["checkout", "-q", "main"]);
    write_all("main");
    commit_all(&fx.work, "main");
    merge_feature(&fx.work);
    let unmerged = git(&fx.work, &["ls-files", "--unmerged", "-z"]);
    assert!(unmerged.len() > 1_000_000, "{}", unmerged.len());
    git(&fx.work, &["checkout", "--ours", "--", "many"]);

    commit::create(&fx.work.join("sub"), "Merge", "", None)
        .await
        .unwrap();
    assert_eq!(
        git(&fx.work, &["show", &format!("HEAD:{}", name(FILES - 1))]),
        format!("main {}\n", FILES - 1)
    );
    assert!(git(&fx.work, &["ls-files", "--unmerged"]).is_empty());
    assert!(!fx.work.join(".git/MERGE_HEAD").exists());
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn commit_all_refuses_a_conflict_in_a_file_named_with_invalid_utf8() {
    use std::os::unix::ffi::OsStrExt;
    let file = std::ffi::OsStr::from_bytes(b"odd\xffname.txt");
    let fx = Fixture::new("commit-invalid-utf8-name");
    let put = |text: &str| std::fs::write(fx.work.join(file), text).unwrap();
    put("base\n");
    write(&fx.work, "sub/chosen.txt", "one\n");
    commit_all(&fx.work, "base");
    git(&fx.work, &["checkout", "-q", "-b", "feature"]);
    put("feature\n");
    commit_all(&fx.work, "feature");
    git(&fx.work, &["checkout", "-q", "main"]);
    put("main\n");
    commit_all(&fx.work, "main");
    merge_feature(&fx.work);
    let head = git(&fx.work, &["rev-parse", "HEAD"]);
    let sub = fx.work.join("sub");

    for refused in [
        commit::prepare_context(&sub, None, true).await.unwrap_err(),
        commit::create(&sub, "All", "", None).await.unwrap_err(),
    ] {
        assert!(
            refused
                .to_string()
                .contains("unresolved merge conflicts in odd\u{fffd}name.txt."),
            "{refused}"
        );
    }
    assert_eq!(git(&fx.work, &["rev-parse", "HEAD"]), head);
    assert!(fx.work.join(".git/MERGE_HEAD").exists());

    put("resolved\n");
    commit::create(&sub, "Merge", "", None).await.unwrap();
    assert!(git(&fx.work, &["ls-files", "--unmerged"]).is_empty());
    assert!(!fx.work.join(".git/MERGE_HEAD").exists());
}

/// A resolution of `notes.txt` of exactly `size` bytes: a Markdown heading, whose `=======`
/// underline Git reports as a possible marker, then one long line.
fn heading_resolution(size: usize) -> String {
    let head = "Heading\n=======\n";
    format!("{head}{}\n", "x".repeat(size - head.len() - 1))
}

#[tokio::test]
async fn commits_a_large_merge_resolution_with_a_heading_underline() {
    for size in [4_096, 1_200_000] {
        let fx = merge_conflict("commit-large-resolution");
        let resolution = heading_resolution(size);
        write(&fx.work, "notes.txt", &resolution);

        commit::create(&fx.work, "Merge", "", None).await.unwrap();

        assert_eq!(
            git(&fx.work, &["rev-list", "--parents", "-n1", "HEAD"])
                .split_whitespace()
                .count(),
            3,
            "{size}"
        );
        assert_eq!(
            git(&fx.work, &["cat-file", "-s", "HEAD:notes.txt"]).trim(),
            size.to_string()
        );
        assert!(git(&fx.work, &["show", "HEAD:notes.txt"]) == resolution);
        assert!(git(&fx.work, &["ls-files", "--unmerged"]).is_empty());
    }
}

#[tokio::test]
async fn refuses_conflict_markers_past_the_first_million_bytes() {
    let fx = merge_conflict("commit-late-markers");
    let padding = "a line of padding text\n".repeat(50_000);
    assert!(padding.len() > 1_000_000, "the markers start past 1 MB");
    write(
        &fx.work,
        "notes.txt",
        &format!("{padding}<<<<<<< HEAD\nmain\n=======\nfeature\n>>>>>>> feature\n"),
    );
    let head = git(&fx.work, &["rev-parse", "HEAD"]);
    let stages = git(&fx.work, &["ls-files", "-s"]);

    let err = commit::create(&fx.work, "Merge", "", None)
        .await
        .unwrap_err();

    assert!(
        err.to_string()
            .contains("Cannot commit with unresolved merge conflicts in notes.txt."),
        "{err}"
    );
    assert_eq!(git(&fx.work, &["rev-parse", "HEAD"]), head);
    assert_eq!(git(&fx.work, &["ls-files", "-s"]), stages);
    assert!(fx.work.join(".git/MERGE_HEAD").exists());
}
