//! `delegate_task` with `isolation: "worktree"`: the child gets its own checkout from the
//! parent's commit (TS `OrchestratorMcpService.delegate` and `ThreadLaunchService.prepareRun`).

use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};

use tokio::sync::Notify;

use super::threads_handoff::{git, git_project, running_parent};
use super::*;

/// The project's setup script, as the host's terminal runner starts it: counted, and with a
/// gate set, held like a running `async: false` script until the test releases it.
#[derive(Default)]
struct SetupStub {
    starts: AtomicUsize,
    started: Notify,
    hold: Mutex<Option<Arc<Notify>>>,
    /// `<thread>:<terminal>` for each terminal closed.
    discarded: Mutex<Vec<String>>,
}

impl SetupStub {
    fn hold(&self) -> Arc<Notify> {
        let gate = Arc::new(Notify::new());
        *self.hold.lock().unwrap() = Some(gate.clone());
        gate
    }
}

impl conn_vcs::setup::SetupRunner for SetupStub {
    fn start<'a>(
        &'a self,
        _thread: &'a str,
        _worktree: &'a std::path::Path,
    ) -> conn_vcs::setup::SetupFuture<'a, Result<Option<conn_vcs::setup::StartedSetup>, String>>
    {
        Box::pin(async move {
            self.starts.fetch_add(1, Ordering::SeqCst);
            self.started.notify_one();
            let Some(gate) = self.hold.lock().unwrap().clone() else {
                return Ok(None);
            };
            Ok(Some(conn_vcs::setup::StartedSetup {
                name: "Install".into(),
                command: "pnpm i".into(),
                terminal_id: "setup-install".into(),
                background: false,
                completion: Box::pin(async move {
                    gate.notified().await;
                    Some(0)
                }),
            }))
        })
    }

    fn discard(&self, thread: &str, terminal_id: &str) {
        self.discarded
            .lock()
            .unwrap()
            .push(format!("{thread}:{terminal_id}"));
    }
}

/// Makes real worktrees, as the server's host does, and records each discard.
struct GitHost {
    setups: conn_vcs::setup::WorktreeSetups,
    setup: Arc<SetupStub>,
    worktrees: PathBuf,
    requests: Mutex<Vec<conn_engine::WorktreeRequest>>,
    discarded: Mutex<Vec<(String, String, Option<String>)>>,
}

impl GitHost {
    fn new(name: &str) -> Arc<Self> {
        let worktrees = std::env::temp_dir().join(format!(
            "conn-mcp-delegate-worktrees-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&worktrees);
        Arc::new(Self {
            setups: conn_vcs::setup::WorktreeSetups::new(),
            setup: Arc::default(),
            worktrees,
            requests: Mutex::default(),
            discarded: Mutex::default(),
        })
    }
}

impl Drop for GitHost {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.worktrees);
    }
}

impl conn_engine::EngineHost for GitHost {
    fn provision_worktree(
        &self,
        request: conn_engine::WorktreeRequest,
    ) -> conn_engine::BoxFuture<'_, Result<conn_engine::ProvisionedWorktree, String>> {
        self.requests.lock().unwrap().push(request.clone());
        Box::pin(async move {
            let made = conn_vcs::setup::provision(
                &self.setups,
                conn_vcs::setup::ProvisionRequest {
                    thread_id: request.thread_id,
                    project_root: PathBuf::from(request.project_root),
                    base_ref: request.base_ref,
                    branch: request.branch,
                    start_from_origin: request.start_from_origin,
                    setup: Some(self.setup.clone()),
                    worktrees_dir: self.worktrees.clone(),
                    submodules: None,
                    missing_base: request.missing_base,
                },
            )
            .await
            .map_err(|e| e.to_string())?;
            Ok(conn_engine::ProvisionedWorktree {
                path: made.path.to_string_lossy().into_owned(),
                branch: made.branch,
            })
        })
    }

    fn discard_worktree(
        &self,
        _thread_id: String,
        project_root: String,
        worktree: conn_engine::ProvisionedWorktree,
        refused: Option<String>,
    ) -> conn_engine::BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            use conn_vcs::worktree::{Removal, delete_branch, remove_worktree};
            let root = PathBuf::from(&project_root);
            remove_worktree(&root, std::path::Path::new(&worktree.path), Removal::Force)
                .await
                .unwrap();
            delete_branch(&root, &worktree.branch, Removal::Force)
                .await
                .unwrap();
            self.discarded
                .lock()
                .unwrap()
                .push((worktree.path, worktree.branch, refused));
            Ok(())
        })
    }
}

fn commit_all(root: &std::path::Path, message: &str) {
    git(root, &["add", "-A"]);
    git(
        root,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-q",
            "-m",
            message,
        ],
    );
}

fn branches(root: &std::path::Path) -> String {
    git(
        root,
        &["branch", "--list", "t3/*", "--format=%(refname:short)"],
    )
}

async fn child_thread(f: &Fixture, child: &str) -> Value {
    f.service
        .config
        .engine
        .get_thread_projection(child.into())
        .await
        .map(|p| conn_contract::to_json(&p))
        .unwrap()["thread"]
        .clone()
}

/// The child's thread is bound to a new worktree on its own `t3/<hex>` branch at the parent's
/// commit, so the parent's uncommitted edits stay out; a retry keeps that one checkout.
#[tokio::test(flavor = "current_thread")]
async fn a_worktree_child_gets_its_own_checkout_from_the_parent_commit() {
    let host = GitHost::new("success");
    let f = fixture_with_host("delegate-worktree", Some(host.clone()));
    let root = git_project(&f).await;
    std::fs::write(root.join("kept.txt"), "committed\n").unwrap();
    commit_all(&root, "kept");
    let head = git(&root, &["rev-parse", "HEAD"]);
    // Uncommitted edits in the parent checkout: a changed file and a new one.
    std::fs::write(root.join("kept.txt"), "dirty\n").unwrap();
    std::fs::write(root.join("untracked.txt"), "new\n").unwrap();

    let (_, caller) = running_parent(&f).await;
    let mut agent = Client::open(&f.service, caller).await;
    let args = json!({"task": "child work", "isolation": "worktree", "clientRequestId": "wt"});
    let task = agent.ok("delegate_task", args.clone()).await;
    let child = task["childThreadId"].as_str().unwrap().to_owned();

    let thread = child_thread(&f, &child).await;
    let path = PathBuf::from(thread["worktreePath"].as_str().unwrap());
    let branch = thread["branch"].as_str().unwrap().to_owned();
    assert!(branch.starts_with("t3/") && branch.len() == 11, "{branch}");
    assert!(path.starts_with(&host.worktrees), "{}", path.display());
    assert_eq!(git(&path, &["rev-parse", "HEAD"]), head);
    assert_eq!(git(&path, &["branch", "--show-current"]), branch);
    assert_eq!(
        std::fs::read_to_string(path.join("kept.txt")).unwrap(),
        "committed\n"
    );
    assert!(!path.join("untracked.txt").exists());
    assert_eq!(git(&path, &["status", "--porcelain"]), "");
    // The parent's edits are untouched.
    assert_eq!(
        std::fs::read_to_string(root.join("kept.txt")).unwrap(),
        "dirty\n"
    );
    let requests = host.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        (
            requests[0].thread_id.as_str(),
            requests[0].base_ref.as_str(),
            requests[0].branch.as_deref(),
            requests[0].start_from_origin
        ),
        (child.as_str(), head.as_str(), None, false)
    );

    // The child ran, in its checkout.
    agent
        .ok(
            "conn_thread_wait",
            json!({"threadId": child, "timeoutMs": 10_000}),
        )
        .await;
    let status = agent
        .ok("task_status", json!({"taskId": task["taskId"]}))
        .await;
    assert_eq!(status["status"], "completed", "{status}");

    // A retry with the same request answers the same task and makes no second checkout.
    let again = agent.ok("delegate_task", args).await;
    assert_eq!(again["childThreadId"], child.as_str());
    assert_eq!(host.requests.lock().unwrap().len(), 1);
    assert_eq!(branches(&root), branch);
    assert!(host.discarded.lock().unwrap().is_empty());
}

/// A parent checkout that is no git repository cannot name a commit: the call is refused
/// with T3's text and makes no child.
#[tokio::test(flavor = "current_thread")]
async fn a_parent_without_git_is_refused() {
    let host = GitHost::new("no-git");
    let f = fixture_with_host("delegate-worktree-no-git", Some(host.clone()));
    let plain = f.dir.join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    f.service
        .config
        .engine
        .call(
            "projects.mutate",
            json!({"type":"project.update","projectId":project_id(),"workspaceRoot":plain}),
        )
        .await
        .unwrap();
    let (parent, caller) = running_parent(&f).await;
    let mut agent = Client::open(&f.service, caller).await;
    let (code, message) = agent
        .failure(
            "delegate_task",
            json!({"task": "child work", "isolation": "worktree"}),
        )
        .await;
    assert_eq!(
        (code.as_str(), message.as_str()),
        (
            "invalid_request",
            "Unable to resolve the parent checkout commit."
        )
    );
    assert!(host.requests.lock().unwrap().is_empty());
    let parent_id = parent["threadId"].as_str().unwrap();
    let read = agent
        .ok("conn_thread_read", json!({"threadId": parent_id}))
        .await;
    assert!(!read.to_string().contains("delegated-task"), "{read}");
}

/// A parent in a worktree of another repository: the project cannot find its commit, so
/// the call is refused with T3's text.
#[tokio::test(flavor = "current_thread")]
async fn a_parent_commit_missing_from_the_project_is_refused() {
    let host = GitHost::new("foreign");
    let f = fixture_with_host("delegate-worktree-foreign", Some(host.clone()));
    git_project(&f).await;
    let other = f.dir.join("other");
    std::fs::create_dir_all(&other).unwrap();
    git(&other, &["init", "-q", "-b", "main"]);
    std::fs::write(other.join("x.txt"), "x\n").unwrap();
    commit_all(&other, "other");
    let mut c = Client::open(&f.service, client(true)).await;
    let parent = c
        .ok(
            "conn_thread_launch",
            json!({
                "projectId": project_id(), "title": "Parent", "message": "hang",
                "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-5-5"},
                "runtimeMode": "auto",
                "workspaceStrategy": {"type": "existing_worktree", "worktreePath": other, "branch": "main"},
            }),
        )
        .await;
    let caller = agent_of(&f, parent["threadId"].as_str().unwrap());
    let mut agent = Client::open(&f.service, caller).await;
    let (code, message) = agent
        .failure(
            "delegate_task",
            json!({"task": "child work", "isolation": "worktree"}),
        )
        .await;
    assert_eq!(code, "invalid_request");
    assert!(
        message.starts_with("Isolation \"worktree\" creates the child checkout in project \"Project\"")
            && message.ends_with("which does not contain the parent checkout's commit. Use isolation \"shared\" to work in the parent's checkout."),
        "{message}"
    );
    assert!(host.requests.lock().unwrap().is_empty());
}

/// A command the engine would refuse makes no checkout and runs no setup script: the
/// refusals that need no write are checked before the worktree is made.
#[tokio::test(flavor = "current_thread")]
async fn a_refused_child_makes_no_worktree_and_runs_no_script() {
    let host = GitHost::new("refused");
    let f = fixture_with_host("delegate-worktree-refused", Some(host.clone()));
    let root = git_project(&f).await;
    let (_, caller) = running_parent(&f).await;
    let mut agent = Client::open(&f.service, caller).await;
    // A blank task passes the tool and is refused by `delegated_task.request`.
    let (code, message) = agent
        .failure(
            "delegate_task",
            json!({"task": "   ", "isolation": "worktree"}),
        )
        .await;
    assert_eq!(code, "orchestration_error", "{message}");
    assert!(
        message.contains("A delegated task needs a task."),
        "{message}"
    );
    assert_eq!(host.setup.starts.load(Ordering::SeqCst), 0);
    assert!(host.requests.lock().unwrap().is_empty());
    assert!(host.discarded.lock().unwrap().is_empty());
    assert_eq!(branches(&root), "");
    assert_eq!(worktree_count(&root), 1);
}

fn worktree_count(root: &std::path::Path) -> usize {
    git(root, &["worktree", "list", "--porcelain"])
        .lines()
        .filter(|l| l.starts_with("worktree "))
        .count()
}

/// A delegate's checkout is prepared under its parent's `linkOrigin`, which the child thread
/// inherits, so the host's setup fence sees the link that started the work.
#[tokio::test(flavor = "current_thread")]
async fn a_worktree_child_is_prepared_under_its_parents_link() {
    let host = GitHost::new("linked");
    let f = fixture_with_host("delegate-worktree-linked", Some(host.clone()));
    git_project(&f).await;
    let link = Caller::Client(ClientCaller {
        session_id: "link-session".into(),
        max_runtime_mode: Some("auto"),
        label: "Peer".into(),
        linked: true,
        narrowed: None,
        scopes: None,
    });
    let mut c = Client::open(&f.service, link).await;
    let parent = c
        .ok(
            "conn_thread_launch",
            json!({
                "projectId": project_id(), "title": "Parent", "message": "hang",
                "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-5-5"},
                "runtimeMode": "auto",
            }),
        )
        .await;
    let parent_id = parent["threadId"].as_str().unwrap();
    let origin = child_thread(&f, parent_id).await["linkOrigin"].clone();
    assert_eq!(origin["sessionId"], "link-session", "{origin}");
    let mut agent = Client::open(&f.service, agent_of(&f, parent_id)).await;
    agent
        .ok(
            "delegate_task",
            json!({"task": "child work", "isolation": "worktree"}),
        )
        .await;
    let requests = host.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].link_origin.as_ref(), Some(&origin));
}

/// Resolved by rebasing onto #262 (merge order #277 → #262 → #314); `GitHost` then implements
/// `cancel_preparation` as the server's host does. Shutdown cancels a delegate whose child is
/// held in its setup script: its terminal, checkout and branch are gone before it returns.
#[tokio::test(flavor = "current_thread")]
#[ignore = "needs #262's launch registry; see the doc comment"]
async fn shutdown_cancels_a_delegate_held_in_its_setup_script() {
    let host = GitHost::new("shutdown");
    let gate = host.setup.hold();
    let f = fixture_with_host("delegate-worktree-shutdown", Some(host.clone()));
    let root = git_project(&f).await;
    let (_, caller) = running_parent(&f).await;
    let mut agent = Client::open(&f.service, caller).await;
    let delegate = agent.request(
        "tools/call",
        json!({"name": "delegate_task", "arguments": {"task": "child work", "isolation": "worktree"}}),
    );
    tokio::pin!(delegate);
    tokio::select! {
        _ = &mut delegate => panic!("the delegate answered before its setup script ran"),
        () = host.setup.started.notified() => {}
    }
    // The call may answer before shutdown returns; both are polled until shutdown does.
    let shutdown = f.service.config.engine.shutdown();
    tokio::pin!(shutdown);
    let mut answered = false;
    loop {
        tokio::select! {
            () = &mut shutdown => break,
            _ = &mut delegate, if !answered => answered = true,
        }
    }
    let discarded = host.setup.discarded.lock().unwrap().clone();
    let (worktrees, branches) = (worktree_count(&root), branches(&root));
    // A setup the shutdown missed ends now.
    gate.notify_one();
    assert_eq!(
        discarded.len(),
        1,
        "the setup terminal was closed: {discarded:?}"
    );
    assert!(discarded[0].ends_with(":setup-install"), "{discarded:?}");
    assert_eq!(worktrees, 1, "the child's checkout was removed");
    assert_eq!(branches, "", "the child's branch was deleted");
}

/// How long a retry gets to start a second setup script. With the registry it waits on the
/// first attempt and never starts one, so this window bounds a check that nothing happens.
const RETRY_WINDOW: std::time::Duration = std::time::Duration::from_secs(1);

/// Resolved by rebasing onto #262 (merge order #277 → #262 → #314), once the delegate's
/// preparation registers the child thread id and a retry waits on the attempt that holds it.
/// A concurrent retry with the same `clientRequestId` joins the first attempt: one checkout,
/// one setup terminal, and both calls answer the same child.
#[tokio::test(flavor = "current_thread")]
#[ignore = "needs #262's launch registry plus a wait on a held id; see the doc comment"]
async fn a_concurrent_retry_joins_the_first_attempts_setup() {
    let host = GitHost::new("retry");
    let gate = host.setup.hold();
    let f = fixture_with_host("delegate-worktree-retry", Some(host.clone()));
    let root = git_project(&f).await;
    let (_, caller) = running_parent(&f).await;
    let args = json!({"task": "child work", "isolation": "worktree", "clientRequestId": "same"});
    let mut first_agent = Client::open(&f.service, caller.clone()).await;
    let mut second_agent = Client::open(&f.service, caller).await;
    let first = first_agent.ok("delegate_task", args.clone());
    tokio::pin!(first);
    tokio::select! {
        _ = &mut first => panic!("the delegate answered before its setup script ran"),
        () = host.setup.started.notified() => {}
    }
    let second = second_agent.ok("delegate_task", args);
    tokio::pin!(second);
    let raced = tokio::time::timeout(RETRY_WINDOW, async {
        tokio::select! {
            _ = &mut second => {}
            () = host.setup.started.notified() => {}
        }
    })
    .await;
    assert!(
        raced.is_err(),
        "the retry started its own setup instead of waiting on the first"
    );
    gate.notify_one();
    let (first, second) = tokio::join!(first, second);
    assert_eq!(first["childThreadId"], second["childThreadId"]);
    assert_eq!(host.setup.starts.load(Ordering::SeqCst), 1);
    assert!(host.setup.discarded.lock().unwrap().is_empty());
    assert_eq!(host.requests.lock().unwrap().len(), 1);
    assert_eq!(worktree_count(&root), 2);
}

/// T3 `resolveProjectScripts`: once project settings are folded, a project without an override
/// uses the machine defaults, and absent defaults are no scripts, never the old project row.
#[tokio::test]
async fn a_folded_project_reset_to_empty_defaults_runs_no_setup_script() {
    use crate::tools::worktree::{ScriptTrigger, start_project_script};
    let config = crate::WorktreeConfig {
        directory: Arc::new(|| std::env::temp_dir().join("worktrees")),
        settings: Arc::new(|| json!({ "projectSettingsFolded": true })),
        terminals: None,
        hub: conn_vcs::VcsHub::default(),
    };
    let project = json!({
        "id": "p1",
        "workspaceRoot": "/repo",
        "scripts": [{ "id": "setup", "name": "Setup", "command": "touch stale", "runOnWorktreeCreate": true }],
    });
    let run = start_project_script(
        &config,
        "t1",
        &project,
        "/repo/wt",
        ScriptTrigger::Setup,
        None,
    )
    .await
    .unwrap();
    assert_eq!(run.started, json!({ "status": "no-script" }));
}

/// `awaitTask` (`OrchestratorMcpService.ts:1984`): a blocking worktree delegate dropped while
/// its checkout's setup script runs still upgrades the task's wake, so the parent hears the
/// result. The dispatch goes on without the caller and commits the child after setup.
#[tokio::test(flavor = "current_thread")]
async fn a_blocking_worktree_delegate_dropped_during_setup_upgrades_the_wake() {
    let host = GitHost::new("dropped-setup");
    let f = fixture_with_host("delegate-worktree-dropped", Some(host.clone()));
    git_project(&f).await;
    let (parent, caller) = running_parent(&f).await;
    let parent = parent["threadId"].as_str().unwrap().to_owned();
    let mut agent = Client::open(&f.service, caller).await;
    let script = host.setup.hold();
    let wait = agent.ok(
        "delegate_task",
        json!({"task": "hang", "isolation": "worktree", "mode": "wait", "timeoutMs": 20000}),
    );
    tokio::select! {
        task = wait => panic!("the wait ended before setup: {task}"),
        () = host.setup.started.notified() => {}
    }
    // The call is gone; the blocking script now exits 0 and the child commits.
    script.notify_one();
    until_wake_upgraded(&f, &parent).await;
}
