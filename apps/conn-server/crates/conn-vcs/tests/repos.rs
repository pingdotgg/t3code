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

/// One scripted answer: the script's `async` flag and where its exit code arrives.
type ScriptAnswer = Option<(bool, tokio::sync::oneshot::Receiver<Option<i64>>)>;

/// A setup runner the test drives: each start takes the next scripted answer, and the
/// completion resolves when the test sends the exit code.
#[derive(Default)]
struct FakeRunner {
    answers: std::sync::Mutex<std::collections::VecDeque<ScriptAnswer>>,
    started: std::sync::Mutex<Vec<(String, PathBuf)>>,
    discarded: std::sync::Mutex<Vec<String>>,
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
