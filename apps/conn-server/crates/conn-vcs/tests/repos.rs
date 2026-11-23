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
    commit, refs, review, status,
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

#[tokio::test]
async fn provision_creates_a_worktree_and_runs_the_setup_script() {
    use conn_contract::{
        ProjectClonePhase as Phase, WorktreeSetupStageId as Id, WorktreeSetupStageStatus as St,
    };
    use conn_vcs::setup::{self, ProvisionError, ProvisionRequest, SetupScript, WorktreeSetups};

    let fx = Fixture::new("provision");
    git(&fx.work, &["tag", "launch-tag"]);
    git(&fx.work, &["push", "-q", "origin", "launch-tag"]);
    git(&fx.work, &["tag", "-d", "launch-tag"]);
    let setups = WorktreeSetups::new();
    let request = |thread: &str, command: &str| ProvisionRequest {
        thread_id: thread.into(),
        project_root: fx.work.clone(),
        base_ref: "main".into(),
        branch: None,
        start_from_origin: true,
        setup_script: Some(SetupScript {
            id: "s1".into(),
            name: "Setup".into(),
            command: command.into(),
        }),
        worktrees_dir: fx.root.path().join("worktrees"),
    };
    let done = setup::provision(
        &setups,
        request(
            "t1",
            "echo one; echo two >&2; echo \"$T3CODE_PROJECT_ROOT\" > root.txt",
        ),
    )
    .await
    .unwrap();
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
        std::fs::read_to_string(done.path.join("root.txt"))
            .unwrap()
            .trim(),
        fx.cwd()
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
    let mut tail = script.tail.clone();
    tail.sort();
    assert_eq!(tail, ["one", "two"]);
    assert_eq!(
        snapshot.worktree_path.as_deref(),
        Some(&*done.path.to_string_lossy())
    );
    setups.finish("t1", Phase::Done, None);
    assert_eq!(
        setups.get("t1").unwrap().stages.last().unwrap().id,
        Id::Agent
    );

    write(&fx.work, "local-only.txt", "local base\n");
    commit_all(&fx.work, "local base");
    git(&fx.origin, &["update-ref", "-d", "refs/heads/main"]);
    let local = setup::provision(&setups, request("deleted", "exit 0"))
        .await
        .unwrap();
    assert_eq!(
        git(&local.path, &["rev-parse", "HEAD"]),
        git(&fx.work, &["rev-parse", "main"])
    );

    // A failing script fails the setup and removes the worktree and its branch.
    let failed = setup::provision(&setups, request("t2", "exit 3"))
        .await
        .unwrap_err();
    assert!(
        matches!(failed, ProvisionError::SetupScript(ref m) if m == "Setup script exited with 3.")
    );
    let snapshot = setups.get("t2").unwrap();
    assert_eq!(snapshot.phase, Phase::Failed);
    let path = PathBuf::from(snapshot.worktree_path.unwrap());
    assert!(!path.exists());
    let branch = snapshot.branch.unwrap();
    assert!(!git(&fx.work, &["branch", "--list", &branch]).contains(&branch));
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

/// The setup script's whole process tree ends when the setup is cancelled, when the launch is
/// dropped, and when the script exits leaving a background job; no entry stays running.
#[tokio::test]
async fn setup_scripts_leave_no_processes_behind() {
    use conn_contract::ProjectClonePhase as Phase;
    use conn_vcs::setup::{self, ProvisionError, ProvisionRequest, SetupScript, WorktreeSetups};

    let fx = Fixture::new("setup-tree");
    let setups = WorktreeSetups::new();
    let request = |thread: &str, command: &str| ProvisionRequest {
        thread_id: thread.into(),
        project_root: fx.work.clone(),
        base_ref: "main".into(),
        branch: None,
        start_from_origin: false,
        setup_script: Some(SetupScript {
            id: "s1".into(),
            name: "Setup".into(),
            command: command.into(),
        }),
        worktrees_dir: fx.root.path().join("worktrees"),
    };
    let pids_dir = fx.root.path().join("pids");
    std::fs::create_dir_all(&pids_dir).unwrap();
    let script = |name: &str, tail: &str| {
        let d = pids_dir.join(name);
        std::fs::create_dir_all(&d).unwrap();
        let d = d.display();
        format!("sleep 30 & echo $! > {d}/bg; sleep 31 & echo $! > {d}/fg; {tail}")
    };

    // Cancelled while it runs.
    let run = {
        let (setups, request) = (setups.clone(), request("cancel", &script("cancel", "wait")));
        tokio::spawn(async move { setup::provision(&setups, request).await })
    };
    let pids = [
        read_pid(&pids_dir.join("cancel/bg")).await,
        read_pid(&pids_dir.join("cancel/fg")).await,
    ];
    assert!(setups.cancel("cancel"));
    let result = run.await.unwrap();
    let left = survivors(&pids).await;
    assert!(
        matches!(result, Err(ProvisionError::Cancelled)),
        "{result:?}"
    );
    assert_eq!(left, Vec::<u32>::new(), "cancel left processes running");

    // The launch future dropped while the script runs.
    let run = {
        let (setups, request) = (setups.clone(), request("drop", &script("drop", "wait")));
        tokio::spawn(async move { setup::provision(&setups, request).await })
    };
    let pids = [
        read_pid(&pids_dir.join("drop/bg")).await,
        read_pid(&pids_dir.join("drop/fg")).await,
    ];
    run.abort();
    let _ = run.await;
    let left = survivors(&pids).await;
    assert_eq!(
        left,
        Vec::<u32>::new(),
        "a dropped launch left processes running"
    );
    assert_ne!(setups.get("drop").unwrap().phase, Phase::Running);

    // The script exits at once, but its background jobs hold its output pipes.
    let started = std::time::Instant::now();
    let done = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        setup::provision(&setups, request("exit", &script("exit", "exit 0"))),
    )
    .await;
    let pids = [
        read_pid(&pids_dir.join("exit/bg")).await,
        read_pid(&pids_dir.join("exit/fg")).await,
    ];
    let left = survivors(&pids).await;
    assert!(
        matches!(done, Ok(Ok(_))),
        "{done:?} after {:?}",
        started.elapsed()
    );
    assert_eq!(
        left,
        Vec::<u32>::new(),
        "background jobs outlived the script"
    );
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
