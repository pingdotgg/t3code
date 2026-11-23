//! Ported from T3's `storageCleanup.test.ts`: the eligibility tables first, then whole sweeps
//! against a real engine and real Git repositories.

use std::{path::Path, process::Command, time::Duration};

use conn_contract::from_json;
use conn_engine::{Engine, EngineConfig, ManualClock, ProjectConfig};
use serde_json::json;

use super::*;

const T0: u64 = 1_795_000_000_000;
const NOW: i64 = 1_795_000_000_000;

fn iso(at: i64) -> Value {
    json!(conn_support::time::iso_from_ms(u64::try_from(at).unwrap()))
}

fn shell(extra: Value) -> Value {
    let mut thread = json!({
        "id": "thread-1", "projectId": "project-1", "branch": "feature",
        "worktreePath": "/worktrees/feature", "status": "idle", "activeRunId": null,
        "pendingBackgroundTasks": [], "pendingRuntimeRequest": null,
        "latestUserMessageAt": null, "latestRunId": null, "latestRunRequestedAt": null,
        "latestRunStartedAt": null, "latestRunCompletedAt": null, "createdAt": iso(NOW - DAY_MS),
        "updatedAt": iso(NOW - DAY_MS), "archivedAt": null, "settledAt": null,
        "settledOverride": null, "pinnedAt": null, "lastErrorClass": null,
        "usageLimitResetAt": null, "limitRecovery": null,
        "lineage": {"rootThreadId": "thread-1", "parentThreadId": null, "relationshipToParent": null},
    });
    if let (Some(base), Some(extra)) = (thread.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            base.insert(key.clone(), value.clone());
        }
    }
    thread
}

const OFF: Recovery = Recovery {
    auto_resume: false,
    snooze: false,
};

#[test]
fn allows_an_idle_worktree_and_rejects_the_project_checkout() {
    assert!(storage_idle(&shell(json!({})), NOW, OFF));
    assert!(!storage_idle(
        &shell(json!({"worktreePath": null})),
        NOW,
        OFF
    ));
}

#[test]
fn retains_a_worktree_while_its_thread_is_busy() {
    for status in ["running", "starting", "preparing", "waiting", "queued"] {
        assert!(
            !storage_idle(&shell(json!({"status": status})), NOW, OFF),
            "{status}"
        );
    }
}

#[test]
fn retains_finished_threads_with_pending_work() {
    for status in ["completed", "interrupted", "cancelled", "rolled_back"] {
        let background = shell(json!({
            "status": status, "pendingBackgroundTasks": [{"taskId": "task-1", "kind": "command"}],
        }));
        assert!(!storage_idle(&background, NOW, OFF), "{status} background");
        let request = shell(json!({
            "status": status,
            "pendingRuntimeRequest": {"id": "request-1", "kind": "command", "createdAt": iso(0)},
        }));
        assert!(!storage_idle(&request, NOW, OFF), "{status} request");
        assert!(
            storage_idle(&shell(json!({"status": status})), NOW, OFF),
            "{status}"
        );
    }
}

#[test]
fn retains_an_active_run_even_if_the_shell_status_is_idle() {
    assert!(!storage_idle(
        &shell(json!({"activeRunId": "run"})),
        NOW,
        OFF
    ));
}

#[test]
fn retains_a_queued_prompt_before_the_new_run_has_been_projected() {
    let queued = shell(json!({"latestUserMessageAt": iso(NOW - 1_000)}));
    assert!(!storage_idle(&queued, NOW, OFF));
}

/// T3: "treats a usage-limited thread $name as idle: $idle".
#[test]
fn usage_limited_threads_follow_the_recovery_rules() {
    struct Case {
        name: &'static str,
        auto_resume: bool,
        snooze: bool,
        armed: bool,
        settled: bool,
        recovery: Recovery,
        reset_in: i64,
        idle: bool,
    }
    let on = Recovery {
        auto_resume: false,
        snooze: true,
    };
    let base = Case {
        name: "",
        auto_resume: false,
        snooze: false,
        armed: true,
        settled: false,
        recovery: on,
        reset_in: DAY_MS,
        idle: false,
    };
    let cases = [
        Case {
            name: "snoozed until a future reset",
            snooze: true,
            ..base
        },
        Case {
            name: "set to auto-resume",
            auto_resume: true,
            ..base
        },
        Case {
            name: "with recovery turned off",
            idle: true,
            ..base
        },
        Case {
            name: "auto-resuming after the reset",
            auto_resume: true,
            reset_in: -1_000,
            ..base
        },
        Case {
            name: "snoozed past its reset",
            snooze: true,
            reset_in: -1_000,
            idle: true,
            ..base
        },
        Case {
            name: "settled with an auto-resume pending",
            auto_resume: true,
            settled: true,
            reset_in: -1_000,
            idle: true,
            ..base
        },
        Case {
            name: "not yet armed by the recovery worker",
            armed: false,
            ..base
        },
        Case {
            name: "not yet armed, auto-resume after reset",
            armed: false,
            recovery: Recovery {
                auto_resume: true,
                snooze: true,
            },
            reset_in: -1_000,
            ..base
        },
        Case {
            name: "never armed because its reset is days overdue",
            armed: false,
            recovery: Recovery {
                auto_resume: true,
                snooze: true,
            },
            reset_in: -5 * DAY_MS,
            idle: true,
            ..base
        },
        Case {
            name: "not armed with recovery settings off",
            armed: false,
            recovery: Recovery {
                auto_resume: false,
                snooze: false,
            },
            idle: true,
            ..base
        },
    ];
    for case in cases {
        let reset = iso(NOW + case.reset_in);
        let thread = shell(json!({
            "status": "failed", "latestRunId": "run-1", "lastErrorClass": "usage_limit",
            "usageLimitResetAt": reset,
            "settledOverride": if case.settled { json!("settled") } else { Value::Null },
            "limitRecovery": if case.armed {
                json!({"runId": "run-1", "resetAt": reset, "autoResume": case.auto_resume, "snooze": case.snooze})
            } else { Value::Null },
        }));
        assert_eq!(
            thread_idle(&thread, NOW, case.recovery),
            case.idle,
            "{}",
            case.name
        );
    }
}

#[test]
fn uses_run_activity_instead_of_metadata_refreshes_for_retention() {
    let run = NOW - 3 * DAY_MS;
    let thread = shell(json!({
        "createdAt": iso(NOW - 5 * DAY_MS), "latestRunCompletedAt": iso(run), "updatedAt": iso(NOW),
    }));
    assert_eq!(activity_at(&thread), run);
}

/// T3: "merged pull request cleanup".
#[test]
fn merged_pull_requests_must_name_the_worktree_head_unless_it_is_integrated() {
    let head = "a".repeat(40);
    let integrated = MergeTarget {
        branch: "feature".into(),
        default_branch: "main".into(),
        head_sha: head.clone(),
        integrated: true,
    };
    let squashed = MergeTarget {
        integrated: false,
        ..integrated.clone()
    };
    let pr = |f: &dyn Fn(&mut PullRequestHead)| {
        let mut pr = PullRequestHead {
            state: "merged".into(),
            head_ref: "feature".into(),
            base_ref: "main".into(),
            head_sha: Some(head.clone()),
        };
        f(&mut pr);
        pr
    };
    assert!(pull_request_merged(
        Some(&pr(&|p| p.head_sha = None)),
        &integrated
    ));
    assert!(pull_request_merged(Some(&pr(&|_| {})), &squashed));
    type Change<'a> = &'a dyn Fn(&mut PullRequestHead);
    let kept: [(&str, Change<'_>); 7] = [
        ("has a later commit", &|p| p.head_sha = Some("c".repeat(40))),
        ("merged into a release branch", &|p| {
            p.base_ref = "release".into()
        }),
        ("merged into its stack parent", &|p| {
            p.base_ref = "stack-parent".into()
        }),
        ("merged without a reported head", &|p| p.head_sha = None),
        ("belongs to a different branch", &|p| {
            p.head_ref = "other".into()
        }),
        ("is still open", &|p| p.state = "open".into()),
        ("was closed without merging", &|p| p.state = "closed".into()),
    ];
    for (name, change) in kept {
        assert!(!pull_request_merged(Some(&pr(change)), &squashed), "{name}");
    }
    assert!(!pull_request_merged(None, &squashed));
    assert!(!pull_request_merged(None, &integrated));
    assert!(!pull_request_merged(
        Some(&pr(&|p| p.state = "open".into())),
        &integrated
    ));
}

/// T3: "subagent worktree ownership".
#[test]
fn only_a_complete_subagent_chain_shares_a_worktree() {
    let parent = shell(json!({"id": "parent", "lineage": {"rootThreadId": "parent"}}));
    let child = |id: &str, parent: &str, relation: &str| {
        shell(json!({"id": id, "lineage": {
            "rootThreadId": "parent", "parentThreadId": parent, "relationshipToParent": relation,
        }}))
    };
    let sub = child("sub", "parent", "subagent");
    let nested = child("nested", "sub", "subagent");
    assert_eq!(
        worktree_owner(&[&parent, &sub, &nested]).map(|o| &o["id"]),
        Some(&json!("parent"))
    );
    let fork = child("fork", "parent", "fork");
    assert!(
        worktree_owner(&[&parent, &fork]).is_none(),
        "a fork is not a subagent"
    );
    let side = shell(json!({"id": "side", "lineage": {
        "rootThreadId": "parent", "parentThreadId": "parent", "sideChat": true,
    }}));
    assert!(
        worktree_owner(&[&parent, &side]).is_some(),
        "a side chat shares ownership"
    );
    let other = shell(json!({"id": "other", "lineage": {"rootThreadId": "other"}}));
    assert!(
        worktree_owner(&[&parent, &other]).is_none(),
        "two top-level threads"
    );
    let orphan = child("orphan", "missing", "subagent");
    assert_eq!(
        worktree_owner(&[&orphan]).map(|o| &o["id"]),
        Some(&json!("orphan"))
    );
}

#[test]
fn project_overrides_replace_the_machine_wide_rules() {
    let settings: Map<String, Value> = from_json(json!({
        "storageCleanup": {"worktreeAfterDays": 3, "worktreeKeepWhen": "tracked-changes"},
        "projectSettingsOverrides": {
            "off": {"worktreeCleanup": {"mode": "off"}},
            "custom": {"worktreeCleanup": {"mode": "custom", "rules": {
                "worktreeAfterDays": null, "worktreeOnMerge": true, "worktreeOnDelete": false,
                "worktreeUnchanged": false,
            }}},
        },
    }))
    .unwrap();
    let global = rules(&settings, None);
    assert_eq!(global.after_days, Some(3));
    assert_eq!(global.keep_when, KeepWhen::TrackedChanges);
    let off = rules(&settings, Some("off"));
    assert!(!off.enabled());
    assert_eq!(
        off.keep_when,
        KeepWhen::TrackedChanges,
        "keeps the machine-wide keep rule"
    );
    let custom = rules(&settings, Some("custom"));
    assert!(custom.on_merge && custom.after_days.is_none());
    assert_eq!(
        custom.keep_when,
        KeepWhen::UncommittedChanges,
        "the custom default"
    );
    assert!(
        !rules(&Map::new(), None).enabled(),
        "every rule is off by default"
    );
}

/// A real project with a bare `origin`, a state folder whose `worktrees` holds a linked
/// worktree on `feature`, an engine on a manual clock, and a terminal manager.
struct Fixture {
    dir: PathBuf,
    project: PathBuf,
    worktree: PathBuf,
    clock: Arc<ManualClock>,
    engine: Arc<SqliteEngine>,
    environment: Arc<Environment>,
    terminals: TerminalManager,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
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
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("conn-wt-cleanup-{}", conn_support::uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = std::fs::canonicalize(&dir).unwrap();
        let origin = dir.join("origin.git");
        let project = dir.join("project");
        git(
            &dir,
            &[
                "init",
                "-q",
                "--bare",
                "-b",
                "main",
                origin.to_str().unwrap(),
            ],
        );
        git(
            &dir,
            &[
                "clone",
                "-q",
                origin.to_str().unwrap(),
                project.to_str().unwrap(),
            ],
        );
        git(&project, &["config", "user.name", "test"]);
        git(&project, &["config", "user.email", "test@example.com"]);
        git(&project, &["checkout", "-q", "-b", "main"]);
        std::fs::write(project.join("README.md"), "# repo\n").unwrap();
        git(&project, &["add", "-A"]);
        git(&project, &["commit", "-qm", "init"]);
        git(&project, &["push", "-q", "-u", "origin", "main"]);
        git(&project, &["remote", "set-head", "origin", "main"]);
        let state = dir.join("state");
        let worktree = state.join("worktrees").join("feature");
        git(
            &project,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feature",
                worktree.to_str().unwrap(),
            ],
        );
        let clock = Arc::new(ManualClock::at(T0));
        let mut config = EngineConfig::new(state.join("engine.sqlite"));
        config.projects = vec![ProjectConfig {
            title: "Project".into(),
            workspace_root: project.to_string_lossy().into_owned(),
        }];
        config.clock = clock.clone();
        let engine = Arc::new(SqliteEngine::open(config).unwrap());
        let environment =
            Arc::new(Environment::load(&state, None, state.clone(), Default::default()).unwrap());
        let terminals = crate::methods::terminal::manager(Some(&environment));
        Self {
            dir,
            project,
            worktree,
            clock,
            engine,
            environment,
            terminals,
        }
    }

    fn project_id(&self) -> String {
        SqliteEngine::project_id_for(&self.project.to_string_lossy())
    }

    fn cleanup(&self) -> WorktreeCleanup {
        WorktreeCleanup::new(
            self.engine.clone(),
            self.environment.clone(),
            self.terminals.clone(),
            None,
        )
    }

    fn rules(&self, storage: Value) {
        self.environment
            .settings
            .update_server(json!({"storageCleanup": storage}))
            .unwrap();
    }

    async fn dispatch(&self, command: Value) {
        self.engine
            .dispatch(from_json(command).unwrap())
            .await
            .ok()
            .unwrap();
    }

    async fn thread(&self, id: &str, worktree: &Path) {
        self.dispatch(json!({
            "type": "thread.create", "commandId": format!("{id}:create"), "threadId": id,
            "projectId": self.project_id(), "title": "Feature",
            "modelSelection": {"instanceId": "codex", "model": "gpt-5.4"},
            "runtimeMode": "full-access", "interactionMode": "default",
            "branch": "feature", "worktreePath": worktree.to_string_lossy(),
            "createdBy": "user", "creationSource": "web",
        }))
        .await;
    }

    fn advance_days(&self, days: u64) {
        self.clock.advance(Duration::from_secs(days * 86_400));
    }

    async fn sweep(&self) -> Vec<(Outcome, String)> {
        self.cleanup()
            .sweep()
            .await
            .into_iter()
            .map(|e| (e.outcome, e.reason))
            .collect()
    }

    fn branch_head(&self) -> Option<String> {
        let out = Command::new("git")
            .args(["rev-parse", "--verify", "--quiet", "refs/heads/feature"])
            .current_dir(&self.project)
            .output()
            .unwrap();
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
    }
}

fn kept(reason: &str) -> Vec<(Outcome, String)> {
    vec![(Outcome::Kept, reason.to_owned())]
}

/// T3: "automatically removes an eligible archived thread checkout", by inactivity. The
/// branch, and so every commit on it, survives.
#[tokio::test(flavor = "current_thread")]
async fn removes_an_inactive_worktree_and_keeps_its_branch() {
    let fx = Fixture::new();
    std::fs::write(fx.worktree.join("feature.txt"), "work\n").unwrap();
    git(&fx.worktree, &["add", "-A"]);
    git(&fx.worktree, &["commit", "-qm", "unpushed work"]);
    let head = git(&fx.worktree, &["rev-parse", "HEAD"]).trim().to_owned();
    fx.thread("thread-1", &fx.worktree).await;
    fx.rules(json!({"worktreeAfterDays": 3}));
    fx.advance_days(2);
    assert_eq!(fx.sweep().await, kept("Inactive for 2 of 3 days"));
    assert!(fx.worktree.exists());
    fx.advance_days(2);
    assert_eq!(
        fx.sweep().await,
        vec![(Outcome::Removed, "Inactive for 4 days".into())]
    );
    assert!(!fx.worktree.exists(), "the checkout is gone");
    assert_eq!(
        fx.branch_head(),
        Some(head),
        "the branch keeps the unpushed commit"
    );
    assert!(
        !git(&fx.project, &["worktree", "list"]).contains("feature"),
        "git forgot the worktree"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn no_rules_remove_nothing() {
    let fx = Fixture::new();
    fx.thread("thread-1", &fx.worktree).await;
    fx.advance_days(400);
    assert_eq!(fx.sweep().await, vec![]);
    assert!(fx.worktree.exists());
}

/// The project's `worktreeCleanup: off` wins over the machine-wide rules.
#[tokio::test(flavor = "current_thread")]
async fn a_project_that_turns_cleanup_off_keeps_its_worktrees() {
    let fx = Fixture::new();
    fx.thread("thread-1", &fx.worktree).await;
    fx.rules(json!({"worktreeAfterDays": 1}));
    fx.environment
        .settings
        .update_server(json!({"projectSettingsOverrides": {
            fx.project_id(): {"worktreeCleanup": {"mode": "off"}},
        }}))
        .unwrap();
    fx.advance_days(5);
    assert_eq!(fx.sweep().await, vec![]);
    assert!(fx.worktree.exists());
}

#[tokio::test(flavor = "current_thread")]
async fn uncommitted_and_untracked_changes_keep_the_worktree() {
    let fx = Fixture::new();
    fx.thread("thread-1", &fx.worktree).await;
    fx.rules(json!({"worktreeAfterDays": 1}));
    fx.advance_days(5);
    std::fs::write(fx.worktree.join("draft.txt"), "draft\n").unwrap();
    assert_eq!(fx.sweep().await, kept("Has uncommitted changes (1 file)"));
    std::fs::write(fx.worktree.join("README.md"), "# edited\n").unwrap();
    assert_eq!(fx.sweep().await, kept("Has uncommitted changes (2 files)"));
    assert!(fx.worktree.join("draft.txt").exists());
    // Tracked-only mode deletes untracked files, never tracked edits.
    fx.rules(json!({"worktreeAfterDays": 1, "worktreeKeepWhen": "tracked-changes"}));
    assert_eq!(fx.sweep().await, kept("Has uncommitted changes (1 file)"));
    git(&fx.worktree, &["checkout", "--", "README.md"]);
    assert_eq!(
        fx.sweep().await,
        vec![(Outcome::Removed, "Inactive for 5 days".into())]
    );
    assert!(!fx.worktree.exists());
}

#[tokio::test(flavor = "current_thread")]
async fn a_switched_branch_keeps_the_worktree() {
    let fx = Fixture::new();
    fx.thread("thread-1", &fx.worktree).await;
    fx.rules(json!({"worktreeAfterDays": 1}));
    fx.advance_days(5);
    git(&fx.worktree, &["checkout", "-q", "-b", "elsewhere"]);
    assert_eq!(fx.sweep().await, kept("Repository or branch changed"));
    git(&fx.worktree, &["checkout", "-q", "--detach"]);
    assert_eq!(fx.sweep().await, kept("Repository or branch changed"));
    assert!(fx.worktree.exists());
}

#[tokio::test(flavor = "current_thread")]
async fn an_open_terminal_keeps_the_worktree() {
    let fx = Fixture::new();
    fx.thread("thread-1", &fx.worktree).await;
    fx.rules(json!({"worktreeAfterDays": 1}));
    fx.advance_days(5);
    let path = fx.worktree.to_string_lossy().into_owned();
    fx.terminals
        .open(
            from_json(
                json!({"threadId": "thread-1", "terminalId": "default", "cwd": path,
            "worktreePath": path}),
            )
            .unwrap(),
        )
        .unwrap();
    assert_eq!(fx.sweep().await, kept("Open terminal"));
    assert!(fx.worktree.exists());
    fx.terminals
        .close(from_json(json!({"threadId": "thread-1", "terminalId": "default"})).unwrap());
    fx.terminals.shutdown().await;
}

#[tokio::test(flavor = "current_thread")]
async fn a_worktree_outside_the_managed_folders_is_kept() {
    let fx = Fixture::new();
    let outside = fx.dir.join("elsewhere");
    git(
        &fx.project,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "other",
            outside.to_str().unwrap(),
        ],
    );
    fx.dispatch(json!({
        "type": "thread.create", "commandId": "outside:create", "threadId": "outside",
        "projectId": fx.project_id(), "title": "Outside",
        "modelSelection": {"instanceId": "codex", "model": "gpt-5.4"},
        "runtimeMode": "full-access", "interactionMode": "default",
        "branch": "other", "worktreePath": outside.to_string_lossy(),
        "createdBy": "user", "creationSource": "web",
    }))
    .await;
    fx.rules(json!({"worktreeAfterDays": 1}));
    fx.advance_days(5);
    assert_eq!(
        fx.sweep().await,
        kept("Outside the managed worktree folder")
    );
    assert!(outside.exists());
}

/// T3: "deleted thread worktrees": only the delete rule acts on a deleted thread's checkout.
#[tokio::test(flavor = "current_thread")]
async fn a_deleted_thread_takes_its_worktree_only_with_the_delete_rule() {
    let fx = Fixture::new();
    fx.thread("thread-1", &fx.worktree).await;
    fx.dispatch(json!({"type": "thread.delete", "commandId": "delete", "threadId": "thread-1"}))
        .await;
    fx.rules(json!({"worktreeAfterDays": 1}));
    fx.advance_days(5);
    assert_eq!(fx.sweep().await, kept("No rules apply"));
    fx.rules(json!({"worktreeAfterDays": null, "worktreeOnDelete": true}));
    assert_eq!(
        fx.sweep().await,
        vec![(Outcome::Removed, "Thread was deleted".into())]
    );
    assert!(!fx.worktree.exists());
    assert!(fx.branch_head().is_some(), "the branch stays");
}

#[tokio::test(flavor = "current_thread")]
async fn a_settled_worktree_goes_after_its_retention() {
    let fx = Fixture::new();
    fx.thread("thread-1", &fx.worktree).await;
    fx.rules(json!({"worktreeSettledAfterDays": 2}));
    assert_eq!(fx.sweep().await, kept("Not settled"));
    fx.advance_days(1);
    fx.dispatch(
        json!({"type": "thread.settle", "commandId": "settle", "threadId": "thread-1",
        "settledAt": conn_support::time::iso_from_ms(fx.engine.now_millis())}),
    )
    .await;
    assert_eq!(fx.sweep().await, kept("Settled moments ago"));
    fx.advance_days(1);
    assert_eq!(fx.sweep().await, kept("Settled for 1 of 2 days"));
    fx.advance_days(1);
    assert_eq!(
        fx.sweep().await,
        vec![(Outcome::Removed, "Settled for 2 days".into())]
    );
    assert!(!fx.worktree.exists());
}

/// T3: "keeps an unsettled new thread's unchanged worktree", then removes it once settled with
/// nothing beyond the default branch; a commit of its own keeps it.
#[tokio::test(flavor = "current_thread")]
async fn an_unchanged_worktree_goes_once_its_thread_settles() {
    let fx = Fixture::new();
    fx.thread("thread-1", &fx.worktree).await;
    fx.rules(json!({"worktreeUnchanged": true}));
    assert_eq!(fx.sweep().await, kept("Not settled"));
    fx.dispatch(
        json!({"type": "thread.settle", "commandId": "settle", "threadId": "thread-1",
        "settledAt": conn_support::time::iso_from_ms(fx.engine.now_millis())}),
    )
    .await;
    fx.advance_days(1);
    std::fs::write(fx.worktree.join("feature.txt"), "work\n").unwrap();
    git(&fx.worktree, &["add", "-A"]);
    git(&fx.worktree, &["commit", "-qm", "own work"]);
    assert_eq!(
        fx.sweep().await,
        kept("Has commits beyond the default branch")
    );
    git(&fx.worktree, &["reset", "-q", "--hard", "origin/main"]);
    assert_eq!(
        fx.sweep().await,
        vec![(
            Outcome::Removed,
            "No commits beyond the default branch".into()
        )]
    );
    assert!(!fx.worktree.exists());
}

/// Two top-level threads in one checkout: neither owns it.
#[tokio::test(flavor = "current_thread")]
async fn a_worktree_two_threads_store_is_kept() {
    let fx = Fixture::new();
    fx.thread("thread-1", &fx.worktree).await;
    fx.thread("thread-2", &fx.worktree).await;
    fx.rules(json!({"worktreeAfterDays": 1}));
    fx.advance_days(5);
    assert_eq!(fx.sweep().await, kept("Shared by 2 threads"));
    assert!(fx.worktree.exists());
}
