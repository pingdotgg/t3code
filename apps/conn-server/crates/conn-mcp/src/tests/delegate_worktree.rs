//! `delegate_task` with `isolation: "worktree"`: the child gets its own checkout from the
//! parent's commit (TS `OrchestratorMcpService.delegate` and `ThreadLaunchService.prepareRun`).

use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};

use super::threads_handoff::{git, git_project, running_parent};
use super::*;

/// The host's setup script runner. A delegate's checkout must never start it: the child's
/// `preparing` run runs the script instead.
#[derive(Default)]
struct SetupStub {
    starts: AtomicUsize,
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
            Ok(None)
        })
    }

    fn discard(&self, _thread: &str, _terminal_id: &str) {}
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
                    setup: request
                        .run_setup
                        .then(|| self.setup.clone() as Arc<dyn conn_vcs::setup::SetupRunner>),
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

/// `skipped-for-link`: a parent a link below full access started runs no setup script for its
/// child, so the child is not held, even by a blocking script. The checkout itself runs none.
#[tokio::test(flavor = "current_thread")]
async fn a_fenced_parents_worktree_child_runs_no_setup_script() {
    let host = GitHost::new("linked");
    let mut f = fixture_with_host("delegate-worktree-linked", Some(host.clone()));
    let terminals = with_terminals(&mut f);
    git_project(&f).await;
    set_setup_script(&f, "linked", HELD_SCRIPT, false).await;
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
    assert_eq!(origin["access"], "auto", "{origin}");
    let mut agent = Client::open(&f.service, agent_of(&f, parent_id)).await;
    let task = agent
        .ok(
            "delegate_task",
            json!({"task": "child work", "isolation": "worktree"}),
        )
        .await;
    let child = task["childThreadId"].as_str().unwrap().to_owned();
    agent
        .ok(
            "conn_thread_wait",
            json!({"threadId": child, "timeoutMs": 30_000}),
        )
        .await;
    let status = agent
        .ok("task_status", json!({"taskId": task["taskId"]}))
        .await;
    assert_eq!(status["status"], "completed", "{status}");
    assert!(!terminals.list().iter().any(|t| t.thread_id == child));
    let requests = host.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    assert!(!requests[0].run_setup);
    assert_eq!(host.setup.starts.load(Ordering::SeqCst), 0);
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
/// its child waits in `preparing` for a blocking setup script still upgrades the task's wake,
/// so the parent hears the result. The preparation goes on without the caller.
#[tokio::test(flavor = "current_thread")]
async fn a_blocking_worktree_delegate_dropped_during_setup_upgrades_the_wake() {
    let host = GitHost::new("dropped-setup");
    let mut f = fixture_with_host("delegate-worktree-dropped", Some(host.clone()));
    let terminals = with_terminals(&mut f);
    let root = git_project(&f).await;
    set_setup_script(&f, "dropped", HELD_SCRIPT, false).await;
    let (parent, caller) = running_parent(&f).await;
    let parent = parent["threadId"].as_str().unwrap().to_owned();
    let mut agent = Client::open(&f.service, caller).await;
    let mut metadata = terminals.subscribe_metadata();
    let wait = agent.ok(
        "delegate_task",
        json!({"task": "hang", "isolation": "worktree", "mode": "wait", "timeoutMs": 20000}),
    );
    tokio::select! {
        task = wait => panic!("the wait ended before setup: {task}"),
        () = async {
            while terminals.list().is_empty() {
                metadata.next().await;
            }
        } => {}
    }
    // The call is gone; the blocking script now exits 0 and the child starts.
    std::fs::write(root.join(".gate"), "0").unwrap();
    until_wake_upgraded(&f, &parent).await;
}

/// T3 runs a worktree child's setup script once, in its preparation: the checkout runs none,
/// and the child's `preparing` run runs it in the child's worktree.
#[tokio::test(flavor = "current_thread")]
async fn a_worktree_childs_setup_script_runs_once_in_its_worktree() {
    let host = GitHost::new("once");
    let mut f = fixture_with_host("delegate-worktree-once", Some(host.clone()));
    let _terminals = with_terminals(&mut f);
    let root = git_project(&f).await;
    set_setup_script(&f, "once", "pwd -P >> \"$T3CODE_PROJECT_ROOT/.ran\"", false).await;
    let (_, caller) = running_parent(&f).await;
    let mut agent = Client::open(&f.service, caller).await;
    let task = agent
        .ok(
            "delegate_task",
            json!({"task": "child work", "isolation": "worktree"}),
        )
        .await;
    let child = task["childThreadId"].as_str().unwrap().to_owned();
    agent
        .ok(
            "conn_thread_wait",
            json!({"threadId": child, "timeoutMs": 30_000}),
        )
        .await;
    let status = agent
        .ok("task_status", json!({"taskId": task["taskId"]}))
        .await;
    assert_eq!(status["status"], "completed", "{status}");
    let worktree = std::fs::canonicalize(
        child_thread(&f, &child).await["worktreePath"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let ran = std::fs::read_to_string(root.join(".ran")).unwrap();
    assert_eq!(
        ran.lines().collect::<Vec<_>>(),
        [worktree.to_str().unwrap()]
    );
    assert_eq!(host.setup.starts.load(Ordering::SeqCst), 0);
}

/// A blocking script that waits for `.gate` in the project root, then exits with its contents.
const HELD_SCRIPT: &str = "while [ ! -f \"$T3CODE_PROJECT_ROOT/.gate\" ]; do sleep 0.05; done; exit \"$(cat \"$T3CODE_PROJECT_ROOT/.gate\")\"";

/// Gives the fixture a real terminal service, so project scripts run in a shell.
fn with_terminals(f: &mut Fixture) -> conn_terminal::TerminalManager {
    let shell = f.dir.join("shell");
    conn_support::test_util::executable(
        &shell,
        "#!/bin/sh\nexport HISTFILE=/dev/null\nexec /bin/sh \"$@\"\n",
    )
    .unwrap();
    let terminals = conn_terminal::TerminalManager::new(conn_terminal::TerminalConfig {
        shells: vec![shell.to_string_lossy().into_owned()],
        ..Default::default()
    });
    Arc::get_mut(&mut f.service)
        .unwrap()
        .config
        .worktrees
        .as_mut()
        .unwrap()
        .terminals = Some(terminals.clone());
    terminals
}

/// The project's one `runOnWorktreeCreate` script; `background` leaves `async` at its default.
async fn set_setup_script(f: &Fixture, id: &str, command: &str, background: bool) {
    let mut setup = json!({"id": "setup", "name": "Install", "icon": "play",
        "command": command, "runOnWorktreeCreate": true});
    if !background {
        setup["async"] = json!(false);
    }
    f.service
        .config
        .engine
        .call(
            "projects.mutate",
            json!({"type": "project.update", "commandId": format!("setup-{id}"),
                "projectId": project_id(), "scripts": [setup]}),
        )
        .await
        .unwrap();
}

/// Audit 1.9, T3's `ThreadLaunchService.prepareRun`: a `worktree` child waits in `preparing`
/// until its synchronous (`async: false`) setup ends. Held, the provider has started nothing;
/// released, it starts once; a failed script starts nothing and fails the run. An async
/// script (the default) still overlaps the agent. A gate file holds each script.
#[tokio::test(flavor = "current_thread")]
async fn a_worktree_child_waits_for_its_synchronous_setup() {
    let host = GitHost::new("setup");
    let provider = conn_engine::fake::FakeProvider::new("claudeAgent");
    let calls = provider.calls.clone();
    let mut f = fixture_with("delegate-worktree-setup", Some(host.clone()), provider);
    let terminals = with_terminals(&mut f);
    let root = git_project(&f).await;
    let gate = root.join(".gate");
    let (_, caller) = running_parent(&f).await;
    let mut agent = Client::open(&f.service, caller).await;
    let starts = |child: &str| {
        calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call.starts_with("start ") && call.contains(child))
            .count()
    };

    for (request, sync, exit, outcome) in [
        ("held", true, "0", "completed"),
        ("broken", true, "3", "failed"),
        ("overlap", false, "0", "completed"),
    ] {
        let _ = std::fs::remove_file(&gate);
        set_setup_script(&f, request, HELD_SCRIPT, !sync).await;
        let task = agent
            .ok(
                "delegate_task",
                json!({"task": "child work", "isolation": "worktree", "clientRequestId": request}),
            )
            .await;
        let child = task["childThreadId"].as_str().unwrap().to_owned();
        if sync {
            let held = child_thread_projection(&f, &child).await;
            assert_eq!(held["runs"][0]["status"], "preparing", "{request}");
            assert_eq!(
                starts(&child),
                0,
                "{request}: nothing reaches the provider while held"
            );
            std::fs::write(&gate, exit).unwrap();
        }
        agent
            .ok(
                "conn_thread_wait",
                json!({"threadId": child, "timeoutMs": 30_000}),
            )
            .await;
        let status = agent
            .ok("task_status", json!({"taskId": task["taskId"]}))
            .await;
        assert_eq!(status["status"], outcome, "{request}: {status}");
        if !sync {
            // The agent finished while its async setup still waits at the gate.
            assert!(!gate.exists(), "{request}");
            std::fs::write(&gate, exit).unwrap();
        }
        let expected = usize::from(outcome == "completed");
        assert_eq!(starts(&child), expected, "{request}");
        if outcome == "failed" {
            let ended = child_thread_projection(&f, &child).await;
            let failure = ended["turnItems"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["type"] == "error")
                .map(|item| item["failure"].clone())
                .unwrap();
            assert_eq!(failure["code"], "workspace_preparation_failed");
            assert_eq!(failure["message"], "Setup script exited with 3.");
        }
        terminals.close(
            conn_contract::from_json(json!({"threadId": child, "terminalId": "setup-setup"}))
                .unwrap(),
        );
    }
}

/// T3's `prepareRun` on interrupt: `task_cancel` during a synchronous setup stops the child,
/// and its setup terminal closes, so the script stops changing the checkout.
#[tokio::test(flavor = "current_thread")]
async fn cancelling_a_child_during_setup_closes_its_setup_terminal() {
    let host = GitHost::new("setup-cancel");
    let provider = conn_engine::fake::FakeProvider::new("claudeAgent");
    let calls = provider.calls.clone();
    let mut f = fixture_with(
        "delegate-worktree-setup-cancel",
        Some(host.clone()),
        provider,
    );
    let terminals = with_terminals(&mut f);
    let _root = git_project(&f).await;
    set_setup_script(&f, "cancel", HELD_SCRIPT, false).await;
    let (_, caller) = running_parent(&f).await;
    let mut agent = Client::open(&f.service, caller).await;
    let task = agent
        .ok(
            "delegate_task",
            json!({"task": "child work", "isolation": "worktree", "clientRequestId": "cancel"}),
        )
        .await;
    let child = task["childThreadId"].as_str().unwrap().to_owned();
    let open = |terminals: &conn_terminal::TerminalManager| {
        terminals.list().iter().any(|t| t.thread_id == child)
    };
    assert!(open(&terminals), "the setup terminal runs");
    let mut metadata = terminals.subscribe_metadata();
    agent
        .ok("task_cancel", json!({"taskId": task["taskId"]}))
        .await;
    let closed = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while open(&terminals) {
            metadata.next().await;
        }
    })
    .await;
    assert!(closed.is_ok(), "the setup terminal closes with the cancel");
    let status = agent
        .ok("task_status", json!({"taskId": task["taskId"]}))
        .await;
    assert_eq!(status["status"], "interrupted", "{status}");
    // T3's interrupt before provider start ends the preparation item too.
    let item = preparation_item(&f, &child).await;
    assert_eq!(item["status"], "interrupted", "{item}");
    assert_eq!(item["title"], "Workspace preparation interrupted");
    assert!(
        !calls
            .lock()
            .unwrap()
            .iter()
            .any(|c| c.starts_with("start ") && c.contains(&child)),
        "the provider never starts"
    );
}

/// T3's archive of a preparing child (`thread.archive`): its run ends `cancelled`, its
/// preparation item says so, and the parent's task finalizes in the same write.
#[tokio::test(flavor = "current_thread")]
async fn archiving_a_preparing_child_finalizes_its_task() {
    let host = GitHost::new("setup-archive");
    let mut f = fixture_with_host("delegate-worktree-setup-archive", Some(host.clone()));
    let _terminals = with_terminals(&mut f);
    git_project(&f).await;
    set_setup_script(&f, "archive", HELD_SCRIPT, false).await;
    let (_, caller) = running_parent(&f).await;
    let mut agent = Client::open(&f.service, caller).await;
    let task = agent
        .ok(
            "delegate_task",
            json!({"task": "child work", "isolation": "worktree"}),
        )
        .await;
    let child = task["childThreadId"].as_str().unwrap().to_owned();
    assert_eq!(
        child_thread_projection(&f, &child).await["runs"][0]["status"],
        "preparing"
    );
    dispatch(
        &f,
        json!({"type": "thread.archive", "commandId": "archive-child", "threadId": child}),
    )
    .await;
    let status = agent
        .ok("task_status", json!({"taskId": task["taskId"]}))
        .await;
    assert_eq!(status["status"], "cancelled", "{status}");
    assert_eq!(status["workState"], "result_available", "{status}");
    let item = preparation_item(&f, &child).await;
    assert_eq!(item["status"], "cancelled", "{item}");
    assert_eq!(item["title"], "Workspace preparation cancelled");
}

/// The child's "Preparing workspace" item.
async fn preparation_item(f: &Fixture, child: &str) -> Value {
    child_thread_projection(f, child).await["turnItems"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["input"] == "Preparing workspace")
        .cloned()
        .unwrap()
}

async fn child_thread_projection(f: &Fixture, child: &str) -> Value {
    f.service
        .config
        .engine
        .get_thread_projection(child.into())
        .await
        .map(|p| conn_contract::to_json(&p))
        .unwrap()
}
