//! `vcs.*`, `subscribeVcsStatus`, `subscribeVcsBranch`, `review.*`, worktree setup and
//! `server.discoverSourceControl`. Owner: the VCS and review track. The git work lives in
//! `conn-vcs`; this file decodes, calls one function, and maps errors.
//!
//! [`VcsShared`] sits in `Deps` because the engine needs the same hub (refresh status when a
//! turn ends) and the same setup tracker (launch into a worktree).

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use conn_contract::{
    OrchestrationV2GetThreadFamilyInput, OrchestrationV2ShellSnapshot, ReviewBranchCommitsInput,
    ReviewDiffFileContentsInput, ReviewDiffPreviewInput, ReviewGetDiffPreviewError,
    VcsBranchStatus, VcsCreateRefInput, VcsCreateWorktreePayload, VcsCreateWorktreeResult,
    VcsCreateWorktreeResultWorktree, VcsInitInput, VcsListRefsInput, VcsPullError, VcsPullInput,
    VcsRefreshBranchError, VcsRefreshStatusPayload, VcsRemoveWorktreeInput, VcsStatusStreamEvent,
    VcsStatusSubscriptionInput, VcsSwitchRefInput, WorktreeSetupCancelResult, to_json,
};
use conn_vcs::{
    VcsError, VcsHub, WorktreeSetups, discovery,
    hub::{Remote, Sink},
    refs, review, worktree,
};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::mpsc;

use super::Deps;
use crate::table::{Failure, ItemStream, MethodTable};

/// Services the engine shares with this area. Cheap to clone; `Default` builds empty ones.
#[derive(Clone, Default)]
pub struct VcsShared {
    pub hub: VcsHub,
    pub setups: WorktreeSetups,
}

/// Items a status or branch subscriber may fall behind by before updates are skipped. Each
/// item is a full replacement, so the next one heals a skipped one.
const STREAM_BUFFER: usize = 16;

struct JsonSink(mpsc::Sender<Result<Value, Failure>>);

impl<T: Serialize + Send> Sink<T> for JsonSink {
    fn send(&self, item: T) -> bool {
        !matches!(
            self.0.try_send(Ok(to_json(&item))),
            Err(mpsc::error::TrySendError::Closed(_))
        )
    }

    fn is_closed(&self) -> bool {
        self.0.is_closed()
    }
}

fn git_failure(error: &VcsError) -> Failure {
    Failure::fail(&VcsPullError::GitCommandError(error.to_git_command_error()))
}

fn status_failure(error: &VcsError) -> Failure {
    Failure::fail(&VcsRefreshBranchError::GitCommandError(
        error.to_git_command_error(),
    ))
}

fn review_failure(error: &VcsError) -> Failure {
    Failure::fail(&error.to_review_error())
}

/// Folders review may read: the server's folder, managed worktrees, and every project.
#[derive(Clone)]
struct Workspaces {
    roots: Vec<PathBuf>,
    deps: Deps,
}

impl Workspaces {
    async fn check(&self, cwd: &str, what: &str, operation: &str) -> Result<(), Failure> {
        let real = std::fs::canonicalize(cwd).unwrap_or_else(|_| PathBuf::from(cwd));
        let within = |root: &Path| {
            let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_owned());
            real.starts_with(root)
        };
        if self.roots.iter().any(|r| within(r)) {
            return Ok(());
        }
        if let Some(engine) = &self.deps.engine
            && let Ok(shell) = engine.shell_snapshot().await
        {
            // Decode into the contract type, so a moved field is a decode error, not an
            // empty list.
            match conn_contract::from_json::<OrchestrationV2ShellSnapshot>(shell) {
                Ok(snapshot) => {
                    if known_workspace(snapshot, real.clone()).await {
                        return Ok(());
                    }
                }
                Err(error) => eprintln!("review: the shell snapshot does not decode: {error}"),
            }
        }
        Err(Failure::fail(&ReviewGetDiffPreviewError::VcsRepositoryDetectionError(
            conn_contract::from_json(serde_json::json!({
                "_tag": "VcsRepositoryDetectionError",
                "operation": operation,
                "cwd": cwd,
                "detail": format!("Review {what} cwd must stay within the configured workspace root."),
            }))
            .expect("valid VcsRepositoryDetectionError"),
        )))
    }
}

/// Whether `real` (canonical) lies in a project or in a thread's worktree that `git worktree
/// list` names for its project, as the T3 server's `KnownWorkspaces.contains` decides.
async fn known_workspace(snapshot: OrchestrationV2ShellSnapshot, real: PathBuf) -> bool {
    let projects: Vec<String> = snapshot
        .projects
        .iter()
        .map(|p| p.workspace_root.clone())
        .collect();
    let worktrees: Vec<(String, String)> = snapshot
        .threads
        .iter()
        .chain(&snapshot.archived_threads)
        .filter_map(|thread| {
            let worktree = thread.worktree_path.clone()?;
            let project = snapshot
                .projects
                .iter()
                .find(|p| p.id == thread.project_id)?;
            Some((project.workspace_root.clone(), worktree))
        })
        .collect();
    // `KnownWorkspaces` resolves paths and runs `git worktree list`.
    tokio::task::spawn_blocking(move || {
        conn_files::KnownWorkspaces::new(&projects, &worktrees).contains(&real)
    })
    .await
    .unwrap_or(false)
}

pub fn register(table: &mut MethodTable, deps: &Deps) {
    let shared = deps.vcs.clone();
    let environment = deps.environment.clone();
    let worktrees_dir = move || {
        environment
            .as_deref()
            .map(crate::host::worktrees_dir)
            .unwrap_or_else(|| std::env::temp_dir().join("conn-server-worktrees"))
    };
    let server_cwd = deps.environment.as_ref().map(|e| e.cwd.clone());
    let workspaces = Workspaces {
        roots: server_cwd
            .iter()
            .cloned()
            .chain([worktrees_dir()])
            .collect(),
        deps: deps.clone(),
    };

    // Status and branch streams.
    let hub = shared.hub.clone();
    table.stream(
        "subscribeVcsStatus",
        move |_, input: VcsStatusSubscriptionInput| {
            let hub = hub.clone();
            async move {
                let (tx, rx) = mpsc::channel(STREAM_BUFFER);
                let sink: Box<dyn Sink<VcsStatusStreamEvent>> = Box::new(JsonSink(tx));
                hub.subscribe_status(
                    &input.cwd,
                    if input.include_remote == Some(false) {
                        Remote::Cached
                    } else {
                        Remote::Read
                    },
                    sink,
                )
                .await
                .map_err(|e| status_failure(&e))?;
                Ok::<ItemStream, Failure>(rx)
            }
        },
    );
    let hub = shared.hub.clone();
    table.stream("subscribeVcsBranch", move |_, input: VcsPullInput| {
        let hub = hub.clone();
        async move {
            let (tx, rx) = mpsc::channel(STREAM_BUFFER);
            let sink: Box<dyn Sink<VcsBranchStatus>> = Box::new(JsonSink(tx));
            hub.subscribe_branch(&input.cwd, sink)
                .await
                .map_err(|e| status_failure(&e))?;
            Ok::<ItemStream, Failure>(rx)
        }
    });
    let hub = shared.hub.clone();
    table.unary(
        "vcs.refreshStatus",
        move |_, input: VcsRefreshStatusPayload| {
            let hub = hub.clone();
            async move {
                hub.refresh_status(
                    &input.cwd,
                    if input.local_only == Some(true) {
                        Remote::Cached
                    } else {
                        Remote::Read
                    },
                )
                .await
                .map_err(|e| status_failure(&e))
            }
        },
    );
    let hub = shared.hub.clone();
    table.unary("vcs.refreshBranch", move |_, input: VcsPullInput| {
        let hub = hub.clone();
        async move {
            hub.refresh_branch(&input.cwd)
                .await
                .map(|_| ())
                .map_err(|e| status_failure(&e))
        }
    });

    // Refs. Each mutation refreshes status for subscribers, as `refreshGitStatus` does.
    table.unary("vcs.listRefs", |_, input: VcsListRefsInput| async move {
        refs::list_refs(input).await.map_err(|e| git_failure(&e))
    });
    let hub = shared.hub.clone();
    table.unary("vcs.switchRef", move |_, input: VcsSwitchRefInput| {
        let hub = hub.clone();
        async move {
            let cwd = input.cwd.clone();
            let result = refs::switch_ref(input).await.map_err(|e| git_failure(&e))?;
            let _ = hub.refresh_local(&cwd).await;
            Ok(result)
        }
    });
    let hub = shared.hub.clone();
    table.unary("vcs.createRef", move |_, input: VcsCreateRefInput| {
        let hub = hub.clone();
        async move {
            let cwd = input.cwd.clone();
            let result = refs::create_ref(input).await.map_err(|e| git_failure(&e))?;
            let _ = hub.refresh_local(&cwd).await;
            Ok(result)
        }
    });
    let hub = shared.hub.clone();
    table.unary("vcs.pull", move |_, input: VcsPullInput| {
        let hub = hub.clone();
        async move {
            let result = refs::pull(Path::new(&input.cwd))
                .await
                .map_err(|e| git_failure(&e))?;
            let _ = hub.refresh_status(&input.cwd, Remote::Cached).await;
            Ok(result)
        }
    });
    let hub = shared.hub.clone();
    table.unary("vcs.init", move |_, input: VcsInitInput| {
        let hub = hub.clone();
        async move {
            let cwd = input.cwd.clone();
            refs::init(input)
                .await
                .map_err(|e| Failure::fail(&e.to_init_error()))?;
            let _ = hub.refresh_local(&cwd).await;
            Ok(())
        }
    });

    // Worktrees, always at the managed path (`path` is null in the contract).
    let hub = shared.hub.clone();
    table.unary(
        "vcs.createWorktree",
        move |_, input: VcsCreateWorktreePayload| {
            let (hub, dir) = (hub.clone(), worktrees_dir());
            async move {
                let created = worktree::create_worktree(&worktree::CreateWorktree {
                    cwd: PathBuf::from(&input.cwd),
                    ref_name: input.ref_name.clone(),
                    new_ref_name: input.new_ref_name.clone(),
                    base_ref_name: input.base_ref_name.clone(),
                    worktrees_dir: dir,
                })
                .await
                .map_err(|e| git_failure(&e))?;
                let _ = hub.refresh_local(&input.cwd).await;
                Ok(VcsCreateWorktreeResult {
                    worktree: VcsCreateWorktreeResultWorktree {
                        path: created.path.to_string_lossy().into_owned(),
                        ref_name: created.ref_name.unwrap_or(input.ref_name),
                    },
                })
            }
        },
    );
    let hub = shared.hub.clone();
    table.unary(
        "vcs.removeWorktree",
        move |_, input: VcsRemoveWorktreeInput| {
            let hub = hub.clone();
            async move {
                worktree::remove_worktree(
                    Path::new(&input.cwd),
                    Path::new(&input.path),
                    if input.force == Some(true) {
                        worktree::Removal::Force
                    } else {
                        worktree::Removal::Safe
                    },
                )
                .await
                .map_err(|e| git_failure(&e))?;
                let _ = hub.refresh_local(&input.cwd).await;
                Ok(())
            }
        },
    );

    // Review.
    let guard = workspaces.clone();
    table.unary(
        "review.getDiffPreview",
        move |_, input: ReviewDiffPreviewInput| {
            let guard = guard.clone();
            async move {
                guard
                    .check(&input.cwd, "diff preview", "ReviewService.getDiffPreview")
                    .await?;
                review::diff_preview(input)
                    .await
                    .map_err(|e| review_failure(&e))
            }
        },
    );
    let guard = workspaces.clone();
    let files = deps.files.clone();
    table.unary(
        "review.getDiffFileContents",
        move |_, input: ReviewDiffFileContentsInput| {
            let (guard, files) = (guard.clone(), files.clone());
            async move {
                guard
                    .check(
                        &input.cwd,
                        "diff file contents",
                        "ReviewService.getDiffFileContents",
                    )
                    .await?;
                let is_internal =
                    move |path: &Path| files.as_ref().is_some_and(|f| f.internal.contains(path));
                review::diff_file_contents(input, is_internal)
                    .await
                    .map_err(|e| review_failure(&e))
            }
        },
    );
    let guard = workspaces;
    table.unary(
        "review.getBranchCommits",
        move |_, input: ReviewBranchCommitsInput| {
            let guard = guard.clone();
            async move {
                guard
                    .check(&input.cwd, "commit list", "ReviewService.getBranchCommits")
                    .await?;
                review::branch_commits(input)
                    .await
                    .map_err(|e| review_failure(&e))
            }
        },
    );

    // Worktree setup progress. Launch (the engine) fills it through `deps.vcs.setups`.
    let setups = shared.setups.clone();
    table.stream(
        "subscribeWorktreeSetup",
        move |_, input: OrchestrationV2GetThreadFamilyInput| {
            let mut updates = setups.subscribe(&input.thread_id);
            async move {
                let (tx, rx) = mpsc::channel(1);
                tokio::spawn(async move {
                    loop {
                        let snapshot = updates.borrow_and_update().clone();
                        if tx.send(Ok(to_json(&snapshot))).await.is_err() {
                            return;
                        }
                        tokio::select! {
                            changed = updates.changed() => if changed.is_err() { return },
                            () = tx.closed() => return,
                        }
                    }
                });
                Ok::<ItemStream, Failure>(rx)
            }
        },
    );
    let setups = shared.setups.clone();
    table.unary(
        "worktreeSetup.cancel",
        move |_, input: OrchestrationV2GetThreadFamilyInput| {
            let cancelled = setups.cancel(&input.thread_id);
            async move { Ok(WorktreeSetupCancelResult { cancelled }) }
        },
    );

    let cwd = Arc::new(server_cwd.unwrap_or_else(std::env::temp_dir));
    table.unary("server.discoverSourceControl", move |_, _: Value| {
        let cwd = cwd.clone();
        async move { Ok::<_, Failure>(discovery::discover(&cwd).await) }
    });
}

#[cfg(test)]
mod tests {
    use std::{process::Command, time::Duration};

    use serde_json::json;

    use super::*;
    use crate::{
        environment::Environment,
        table::{CallContext, Handler},
    };

    fn git(cwd: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args([
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.hooksPath=/dev/null",
            ])
            .args(args)
            .current_dir(cwd)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    async fn unary(table: &MethodTable, tag: &str, input: Value) -> Result<Value, Failure> {
        let Some(Handler::Unary(call)) = table.get(tag) else {
            panic!("{tag} is not a unary method")
        };
        call(CallContext::default(), input).await
    }

    async fn stream(table: &MethodTable, tag: &str, input: Value) -> ItemStream {
        let Some(Handler::Stream(call)) = table.get(tag) else {
            panic!("{tag} is not a stream")
        };
        call(CallContext::default(), input).await.unwrap()
    }

    async fn next(items: &mut ItemStream) -> Value {
        tokio::time::timeout(Duration::from_secs(15), items.recv())
            .await
            .expect("an item within 15 s")
            .unwrap()
            .unwrap()
    }

    /// Review reads a project added at run time, outside the server's folder. All three
    /// `review.*` methods go through the same guard, and refuse a folder outside every project.
    #[tokio::test(flavor = "current_thread")]
    async fn review_follows_projects_added_at_run_time() {
        let root =
            std::env::temp_dir().join(format!("conn-server-review-{}", crate::auth::random_hex(6)));
        std::fs::create_dir_all(root.join("server")).unwrap();
        std::fs::create_dir_all(root.join("project")).unwrap();
        std::fs::create_dir_all(root.join("elsewhere")).unwrap();
        let root = std::fs::canonicalize(&root).unwrap();
        let project = root.join("project");
        git(&project, &["init", "-q", "-b", "main"]);
        std::fs::write(project.join("a.txt"), "a\n").unwrap();
        git(&project, &["add", "."]);
        git(&project, &["commit", "-qm", "init"]);
        git(&root.join("elsewhere"), &["init", "-q", "-b", "main"]);

        let engine: Arc<dyn conn_engine::Engine> = Arc::new(
            conn_engine::SqliteEngine::open(conn_engine::EngineConfig::new(
                root.join("engine.sqlite"),
            ))
            .unwrap(),
        );
        let environment =
            Arc::new(Environment::load(&root.join("state"), None, root.join("server")).unwrap());
        let deps = Deps {
            engine: Some(engine),
            environment: Some(environment),
            ..Deps::default()
        };
        let mut table = MethodTable::new();
        register(&mut table, &deps);
        super::super::projects::register(&mut table, &deps);
        let cwd = project.to_string_lossy().into_owned();
        unary(
            &table,
            "projects.mutate",
            json!({"type": "project.create", "commandId": "c1", "projectId": "p1",
                   "title": "Project", "workspaceRoot": cwd}),
        )
        .await
        .unwrap();

        // A thread worktree outside every root, which `git worktree list` names for the
        // project, and a thread that claims a folder git does not list.
        let worktree = root.join("wt");
        git(
            &project,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "wt",
                &worktree.to_string_lossy(),
            ],
        );
        let elsewhere = root.join("elsewhere").to_string_lossy().into_owned();
        for (thread, path) in [
            ("t1", worktree.to_string_lossy().into_owned()),
            ("t2", elsewhere.clone()),
        ] {
            let create = json!({
                "type": "thread.create", "commandId": format!("c-{thread}"), "threadId": thread,
                "projectId": "p1", "title": "T",
                "modelSelection": {"instanceId": "claudeAgent", "model": "m"},
                "runtimeMode": "full-access", "interactionMode": "default",
                "branch": null, "worktreePath": path, "createdBy": "user", "creationSource": "web",
            });
            deps.engine
                .as_ref()
                .unwrap()
                .dispatch(conn_contract::from_json(create).unwrap())
                .await
                .unwrap();
        }
        let in_worktree = unary(
            &table,
            "review.getDiffPreview",
            json!({ "cwd": worktree.to_string_lossy() }),
        )
        .await;
        assert!(in_worktree.is_ok(), "the thread worktree: {in_worktree:?}");

        let calls = [
            ("review.getDiffPreview", json!({ "cwd": cwd })),
            (
                "review.getDiffFileContents",
                json!({ "cwd": cwd, "sourceKind": "working-tree", "changeType": "change",
                        "baseRef": null, "headRef": null, "oldPath": "a.txt", "newPath": "a.txt" }),
            ),
            ("review.getBranchCommits", json!({ "cwd": cwd })),
        ];
        for (tag, input) in calls {
            let refused = |result: &Result<Value, Failure>| {
                matches!(result, Err(Failure::Fail(e))
                    if e["_tag"] == "VcsRepositoryDetectionError"
                        && e["detail"].as_str().unwrap_or("").contains("workspace root"))
            };
            let inside = unary(&table, tag, input.clone()).await;
            assert!(!refused(&inside), "{tag} refused the project: {inside:?}");
            let mut outside_input = input;
            outside_input["cwd"] = json!(elsewhere);
            let outside = unary(&table, tag, outside_input).await;
            assert!(
                refused(&outside),
                "{tag} read outside every project: {outside:?}"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn serves_status_refs_worktrees_review_and_setup() {
        let root = std::env::temp_dir().join(format!("conn-server-vcs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let root = std::fs::canonicalize(&root).unwrap();
        let repo = root.join("repo");
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "a\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-qm", "init"]);
        let environment =
            Arc::new(Environment::load(&root.join("state"), None, repo.clone()).unwrap());
        let deps = Deps {
            environment: Some(environment),
            ..Deps::default()
        };
        let mut table = MethodTable::new();
        register(&mut table, &deps);
        let cwd = repo.to_string_lossy().into_owned();

        // Status stream: a snapshot, then a local update after a refresh.
        let mut status = stream(&table, "subscribeVcsStatus", json!({ "cwd": cwd })).await;
        let snapshot = next(&mut status).await;
        assert_eq!(snapshot["_tag"], "snapshot");
        assert_eq!(snapshot["local"]["refName"], "main");
        assert_eq!(snapshot["local"]["isRepo"], true);
        std::fs::write(repo.join("a.txt"), "a\nb\n").unwrap();
        let refreshed = unary(
            &table,
            "vcs.refreshStatus",
            json!({ "cwd": cwd, "localOnly": true }),
        )
        .await
        .unwrap();
        assert_eq!(refreshed["hasWorkingTreeChanges"], true);
        assert_eq!(refreshed["hasUpstream"], false);
        let update = next(&mut status).await;
        assert_eq!(update["_tag"], "localUpdated");
        assert_eq!(update["local"]["workingTree"]["insertions"], 1);

        // Branch stream follows a branch made and switched to over RPC.
        let mut branch = stream(&table, "subscribeVcsBranch", json!({ "cwd": cwd })).await;
        assert_eq!(
            next(&mut branch).await,
            json!({ "refName": "main", "isRepo": true })
        );
        unary(
            &table,
            "vcs.createRef",
            json!({ "cwd": cwd, "refName": "topic", "switchRef": true }),
        )
        .await
        .unwrap();
        assert_eq!(next(&mut branch).await["refName"], "topic");
        // ... and a checkout made outside the server, seen by the HEAD stat ticker.
        git(&repo, &["checkout", "-q", "main"]);
        assert_eq!(next(&mut branch).await["refName"], "main");

        let refs = unary(&table, "vcs.listRefs", json!({ "cwd": cwd }))
            .await
            .unwrap();
        assert_eq!(refs["totalCount"], 2);
        assert_eq!(refs["refs"][0]["name"], "main");

        let Err(Failure::Fail(error)) = unary(
            &table,
            "vcs.switchRef",
            json!({ "cwd": cwd, "refName": "nope" }),
        )
        .await
        else {
            panic!("expected a typed failure")
        };
        assert_eq!(error["_tag"], "GitCommandError");

        // Worktrees live under the state folder.
        let created = unary(
            &table,
            "vcs.createWorktree",
            json!({ "cwd": cwd, "refName": "main", "newRefName": "wt/one", "path": null }),
        )
        .await
        .unwrap();
        let path = created["worktree"]["path"].as_str().unwrap().to_owned();
        assert!(
            path.starts_with(
                &root
                    .join("state/worktrees/repo")
                    .to_string_lossy()
                    .into_owned()
            )
        );
        assert_eq!(created["worktree"]["refName"], "wt/one");
        let preview = unary(&table, "review.getDiffPreview", json!({ "cwd": path }))
            .await
            .unwrap();
        assert_eq!(preview["sources"].as_array().unwrap().len(), 2);
        unary(
            &table,
            "vcs.removeWorktree",
            json!({ "cwd": cwd, "path": path, "force": true }),
        )
        .await
        .unwrap();
        // The `worktreesDirectory` setting moves new worktrees, as for a thread launch.
        let custom = root.join("custom-worktrees");
        deps.environment
            .as_ref()
            .unwrap()
            .settings
            .update(json!({ "worktreesDirectory": custom }), None)
            .unwrap();
        let created = unary(
            &table,
            "vcs.createWorktree",
            json!({ "cwd": cwd, "refName": "main", "newRefName": "wt/two", "path": null }),
        )
        .await
        .unwrap();
        let path = created["worktree"]["path"].as_str().unwrap().to_owned();
        assert!(
            path.starts_with(&custom.join("repo").to_string_lossy().into_owned()),
            "{path}"
        );
        unary(
            &table,
            "vcs.removeWorktree",
            json!({ "cwd": cwd, "path": path, "force": true }),
        )
        .await
        .unwrap();

        // Review in the project, and refused outside it.
        let preview = unary(
            &table,
            "review.getDiffPreview",
            json!({ "cwd": cwd, "sourceKind": "working-tree" }),
        )
        .await
        .unwrap();
        assert_eq!(preview["sources"][0]["files"][0]["path"], "a.txt");
        let Err(Failure::Fail(error)) =
            unary(&table, "review.getDiffPreview", json!({ "cwd": "/" })).await
        else {
            panic!("expected a typed failure")
        };
        assert_eq!(error["_tag"], "VcsRepositoryDetectionError");
        let commits = unary(&table, "review.getBranchCommits", json!({ "cwd": cwd }))
            .await
            .unwrap();
        assert_eq!(commits, json!({ "commits": [], "truncated": false }));

        // Worktree setup: unknown thread streams null; cancel finds nothing.
        let mut setup = stream(
            &table,
            "subscribeWorktreeSetup",
            json!({ "threadId": "t1" }),
        )
        .await;
        assert_eq!(next(&mut setup).await, Value::Null);
        deps.vcs.setups.begin("t1", None, Some("main".into()), &[]);
        assert_eq!(next(&mut setup).await["phase"], "running");
        assert_eq!(
            unary(&table, "worktreeSetup.cancel", json!({ "threadId": "t1" }))
                .await
                .unwrap(),
            json!({ "cancelled": true })
        );

        let discovered = unary(&table, "server.discoverSourceControl", json!({}))
            .await
            .unwrap();
        assert_eq!(discovered["versionControlSystems"][0]["kind"], "git");
        assert_eq!(
            discovered["versionControlSystems"][0]["status"],
            "available"
        );

        drop((status, branch, setup));
        let _ = std::fs::remove_dir_all(&root);
    }
}
