//! `delegate_task` with `isolation: "worktree"`: the child gets its own checkout from the
//! parent's commit (TS `OrchestratorMcpService.delegate` and `ThreadLaunchService.prepareRun`).

use std::sync::Mutex;

use super::threads_handoff::{git, git_project, running_parent};
use super::*;

/// Makes real worktrees, as the server's host does, and records each discard.
struct GitHost {
    setups: conn_vcs::setup::WorktreeSetups,
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
                    setup_script: None,
                    worktrees_dir: self.worktrees.clone(),
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
    ) -> conn_engine::BoxFuture<'_, ()> {
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
            "t3_thread_wait",
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
        .ok("t3_thread_read", json!({"threadId": parent_id}))
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
            "t3_thread_launch",
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

/// A child worktree whose command the engine then refuses is removed with its branch.
#[tokio::test(flavor = "current_thread")]
async fn a_refused_child_leaves_no_worktree_or_branch() {
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
    assert_eq!(host.requests.lock().unwrap().len(), 1);
    let discarded = host.discarded.lock().unwrap().clone();
    assert_eq!(discarded.len(), 1);
    assert!(
        discarded[0]
            .2
            .as_deref()
            .is_some_and(|r| r.contains("A delegated task needs a task."))
    );
    assert!(!PathBuf::from(&discarded[0].0).exists());
    assert_eq!(branches(&root), "");
    assert_eq!(
        git(&root, &["worktree", "list", "--porcelain"])
            .lines()
            .filter(|l| l.starts_with("worktree "))
            .count(),
        1
    );
}
