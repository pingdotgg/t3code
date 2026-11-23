//! The server's services as the engine sees them ([`conn_engine::EngineHost`] and
//! [`conn_engine::TurnObserver`]): `/mcp` credentials per provider session, attachment claims,
//! worktrees, terminals that close with their thread, and VCS status after a turn.

use std::{
    path::PathBuf,
    sync::{Arc, OnceLock},
};

use conn_contract::{
    ChatAttachment, ProjectClonePhase, TerminalCloseInput, WorktreeSetupStageId, from_json, to_json,
};
use conn_engine::{
    AgentSession, AgentTools, BoxFuture, EngineHost, ProvisionedWorktree, ThreadClose,
    TurnObserver, TurnPoint, WorktreeRequest,
};
use conn_mcp::{McpService, ThreadCredentialRequest};
use conn_provider::McpServer;
use conn_terminal::TerminalManager;
use conn_vcs::setup::{ProvisionRequest, provision};
use serde_json::Value;

use crate::{environment::Environment, methods::vcs::VcsShared};

pub struct Host {
    /// Set once the service exists; it needs the engine, which needs this host.
    pub mcp: OnceLock<Arc<McpService>>,
    pub files: Option<Arc<conn_files::Files>>,
    pub vcs: VcsShared,
    pub terminals: TerminalManager,
    pub environment: Arc<Environment>,
    /// Set once the service exists; it needs the engine, which needs this host.
    pub scheduled_tasks: OnceLock<conn_features::scheduled::ScheduledTasks>,
    /// Device sessions a closed thread held (`ResourceCleanupService.cleanupDevices`).
    pub devices: OnceLock<conn_devices::Devices>,
}

impl std::fmt::Debug for Host {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Host")
            .field("environment", &self.environment)
            .finish_non_exhaustive()
    }
}

/// Where new managed worktrees go: `worktreesDirectory` from the settings, else
/// `<state-dir>/worktrees`. Read on each use, so a settings change applies to the next
/// worktree. Thread launch and `vcs.createWorktree` both use this one function.
pub fn worktrees_dir(environment: &Environment) -> PathBuf {
    let setting = environment.settings.raw();
    match setting.get("worktreesDirectory").and_then(Value::as_str) {
        Some(dir) if !dir.trim().is_empty() => PathBuf::from(dir.trim()),
        _ => environment.state_dir.join("worktrees"),
    }
}

impl Host {
    fn worktrees_dir(&self) -> PathBuf {
        worktrees_dir(&self.environment)
    }

    /// The project's setup script, run in the thread's terminal. `None` without the `/mcp`
    /// service, which owns the project script runner.
    fn setup_runner(
        &self,
        project_id: Option<String>,
        link_origin: Option<Value>,
    ) -> Option<Arc<dyn conn_vcs::setup::SetupRunner>> {
        Some(Arc::new(TerminalSetup {
            mcp: self.mcp.get()?.clone(),
            setups: self.vcs.setups.clone(),
            project_id: project_id?,
            link_origin,
        }))
    }
}

/// `ProjectSetupScriptRunner.runForThread` for a launch: the script runs in terminal
/// `setup-<id>`, and its output lines go to the setup's tail.
struct TerminalSetup {
    mcp: Arc<McpService>,
    setups: conn_vcs::WorktreeSetups,
    project_id: String,
    /// The thread's `linkOrigin`: a fenced one runs no script.
    link_origin: Option<Value>,
}

impl conn_vcs::setup::SetupRunner for TerminalSetup {
    fn start<'a>(
        &'a self,
        thread: &'a str,
        worktree: &'a std::path::Path,
    ) -> conn_vcs::setup::SetupFuture<'a, Result<Option<conn_vcs::setup::StartedSetup>, String>>
    {
        Box::pin(async move {
            let (setups, owner) = (self.setups.clone(), thread.to_owned());
            let on_line = Box::new(move |line: String| {
                setups.append_tail(&owner, WorktreeSetupStageId::SetupScript, &line);
            });
            let path = worktree.to_string_lossy();
            let started = self
                .mcp
                .start_launch_setup(
                    thread,
                    &self.project_id,
                    self.link_origin.as_ref(),
                    &path,
                    on_line,
                )
                .await?;
            Ok(started.map(|s| conn_vcs::setup::StartedSetup {
                name: s.name,
                command: s.command,
                terminal_id: s.terminal_id,
                background: s.background,
                completion: Box::pin(async move { s.completion.await.ok().flatten() }),
            }))
        })
    }

    fn discard(&self, thread: &str, terminal_id: &str) {
        self.mcp.discard_launch_setup(thread, terminal_id);
    }
}

impl Host {
    fn credential_request(&self, session: AgentSession) -> ThreadCredentialRequest {
        ThreadCredentialRequest {
            preview: crate::settings::agent_browser_access(
                &self.environment.settings.raw(),
                session.project_id.as_deref(),
            ),
            device: conn_devices::agent_device_access(
                &self.environment.settings.raw(),
                session.project_id.as_deref(),
            ),
            thread_id: session.thread_id,
            provider_instance_id: session.provider_instance_id,
            subagent: session.subagent,
        }
    }
}

impl EngineHost for Host {
    fn provider_instance_enabled(&self, project_id: Option<&str>, instance_id: &str) -> bool {
        crate::settings::provider_instance_enabled(
            &self.environment.settings.raw(),
            project_id,
            instance_id,
        )
    }

    fn response_streaming_mode(
        &self,
        project_id: Option<&str>,
    ) -> conn_engine::ResponseStreamingMode {
        crate::settings::response_streaming_mode(&self.environment.settings.raw(), project_id)
    }

    fn agent_tools(&self, session: AgentSession) -> Option<AgentTools> {
        let request = self.credential_request(session);
        let device_tools = request.device;
        let entry = self.mcp.get()?.issue_thread_credential(request);
        Some(AgentTools {
            servers: vec![McpServer {
                device_tools,
                name: conn_mcp::SERVER_NAME.to_owned(),
                url: entry.url,
                headers: vec![("Authorization".to_owned(), entry.authorization)],
            }],
            key: entry.provider_session_id,
        })
    }

    fn agent_tools_fit(&self, session: &AgentSession, key: &str) -> bool {
        self.mcp.get().is_some_and(|mcp| {
            mcp.thread_credential_fits(key, &self.credential_request(session.clone()))
        })
    }

    fn session_closed(&self, key: &str) {
        if let Some(mcp) = self.mcp.get() {
            mcp.revoke_provider_session(key);
        }
    }

    fn snapshot_mcp_app(
        &self,
        thread: String,
        source: conn_provider::mcp_apps::Source,
        contents: Value,
    ) -> BoxFuture<'_, Result<Option<Value>, String>> {
        let files = self.files.clone();
        Box::pin(async move {
            let Some(files) = files else {
                return Ok(None);
            };
            tokio::task::spawn_blocking(move || {
                files.attachments.snapshot_mcp_app(
                    &thread,
                    &source.server,
                    &source.tool,
                    &source.resource_uri,
                    &contents,
                )
            })
            .await
            .map_err(|e| e.to_string())?
        })
    }

    fn claim_attachments(
        &self,
        thread_id: String,
        attachments: Value,
    ) -> BoxFuture<'_, Result<Value, String>> {
        let files = self.files.clone();
        Box::pin(async move {
            let Some(files) = files else {
                return Ok(attachments);
            };
            let list: Vec<ChatAttachment> = from_json(attachments).map_err(|e| e.to_string())?;
            tokio::task::spawn_blocking(move || {
                files
                    .attachments
                    .claim_all(&thread_id, &list)
                    .map(|claimed| to_json(&claimed))
            })
            .await
            .map_err(|e| e.to_string())?
        })
    }

    fn release_attachments(&self, attachments: Value) -> BoxFuture<'_, ()> {
        let files = self.files.clone();
        Box::pin(async move {
            let (Some(files), Ok(list)) = (files, from_json::<Vec<ChatAttachment>>(attachments))
            else {
                return;
            };
            let _ = tokio::task::spawn_blocking(move || files.attachments.release(&list)).await;
        })
    }

    fn current_branch(&self, cwd: &str) -> BoxFuture<'_, Option<String>> {
        let cwd = PathBuf::from(cwd);
        Box::pin(async move { conn_vcs::repo::current_branch(&cwd).await.ok().flatten() })
    }

    fn provision_worktree(
        &self,
        request: WorktreeRequest,
    ) -> BoxFuture<'_, Result<ProvisionedWorktree, String>> {
        Box::pin(async move {
            let made = provision(
                &self.vcs.setups,
                ProvisionRequest {
                    thread_id: request.thread_id,
                    project_root: PathBuf::from(request.project_root),
                    base_ref: request.base_ref,
                    branch: request.branch,
                    start_from_origin: request.start_from_origin,
                    setup: self.setup_runner(request.project_id, request.link_origin),
                    worktrees_dir: self.worktrees_dir(),
                },
            )
            .await
            .map_err(|e| e.to_string())?;
            Ok(ProvisionedWorktree {
                path: made.path.to_string_lossy().into_owned(),
                branch: made.branch,
            })
        })
    }

    fn launch_committed(&self, thread_id: &str) {
        let setups = &self.vcs.setups;
        if setups
            .get(thread_id)
            .is_some_and(|s| s.phase == ProjectClonePhase::Running)
        {
            setups.agent_started(thread_id);
        }
    }

    fn discard_worktree(
        &self,
        thread_id: String,
        project_root: String,
        worktree: ProvisionedWorktree,
        refused: Option<String>,
    ) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            use conn_vcs::worktree::{Removal, delete_branch, remove_worktree};
            let root = PathBuf::from(project_root);
            let path = PathBuf::from(&worktree.path);
            if let Err(error) = remove_worktree(&root, &path, Removal::Force).await {
                eprintln!("discard worktree {}: {error}", worktree.path);
            }
            if let Err(error) = delete_branch(&root, &worktree.branch, Removal::Force).await {
                eprintln!("discard branch {}: {error}", worktree.branch);
            }
            // A refused command left no thread to show the setup script's terminal. A replay's
            // terminal id is the winning attempt's, so it stays.
            let terminal = refused.as_ref().and(
                self.vcs
                    .setups
                    .get(&thread_id)
                    .and_then(|s| s.setup_script)
                    .map(|s| s.terminal_id),
            );
            if let (Some(mcp), Some(terminal)) = (self.mcp.get(), terminal) {
                mcp.discard_launch_setup(&thread_id, &terminal);
            }
            // A refused command made no thread, so no agent ends its setup. A replay leaves
            // the setup to the attempt that made the thread.
            if let Some(reason) = refused {
                self.vcs
                    .setups
                    .finish(&thread_id, ProjectClonePhase::Failed, Some(&reason));
            }
        })
    }

    fn cleanup_html_attachments(&self, ids: Vec<(String, String)>) -> BoxFuture<'_, ()> {
        let files = self.files.clone();
        Box::pin(async move {
            let Some(files) = files else {
                return;
            };
            let result = tokio::task::spawn_blocking(move || {
                for (owner, id) in ids {
                    if let Err(error) = conn_files::html::cleanup(&files, &owner, &id) {
                        eprintln!("HTML attachment cleanup: {error}");
                    }
                }
            })
            .await;
            if let Err(error) = result {
                eprintln!("HTML attachment cleanup: {error}");
            }
        })
    }

    fn remote_task_changed(&self, thread_id: &str, task_id: &str) {
        if let Some(mcp) = self.mcp.get() {
            mcp.follow_remote_task(thread_id, task_id);
        }
    }

    fn thread_closed(&self, thread_id: &str, reason: ThreadClose) {
        match reason {
            ThreadClose::Settled | ThreadClose::SettledAgain => {
                // `closeOnSettle`: `stopOnSettle` terminals, then every idle one; then
                // `cleanUpSettledThread` runs the project's settle script in the worktree.
                self.terminals.close_on_settle(thread_id);
                let terminals = self.terminals.clone();
                // `settleActionRunAt`: the script runs once per settlement, so only on the
                // transition to settled.
                let mcp = self
                    .mcp
                    .get()
                    .cloned()
                    .filter(|_| reason == ThreadClose::Settled);
                let thread_id = thread_id.to_owned();
                tokio::spawn(async move {
                    terminals.close_idle(&thread_id, None).await;
                    if let Some(mcp) = mcp {
                        mcp.run_settle_script(&thread_id).await;
                    }
                });
            }
            ThreadClose::Archived | ThreadClose::Deleted => {
                self.terminals.close(TerminalCloseInput {
                    thread_id: thread_id.to_owned(),
                    terminal_id: None,
                    delete_history: Some(reason == ThreadClose::Deleted),
                });
                // The thread's device sessions end; the devices stay on for other threads.
                if let Some(devices) = self.devices.get().cloned() {
                    let thread_id = thread_id.to_owned();
                    tokio::spawn(async move { devices.cleanup_thread(&thread_id).await });
                }
            }
        }
        // `ResourceCleanupService`: a deleted thread takes the tasks bound to it.
        if reason == ThreadClose::Deleted
            && let Some(tasks) = self.scheduled_tasks.get().cloned()
        {
            let thread_id = thread_id.to_owned();
            tokio::spawn(async move {
                if let Err(error) = tasks.delete_for_thread(&thread_id).await {
                    eprintln!("scheduled tasks: {error}");
                }
            });
        }
    }
}

impl TurnObserver for Host {
    fn turn_started(&self, point: TurnPoint) -> BoxFuture<'_, ()> {
        if let Some(mcp) = self.mcp.get() {
            mcp.touch_thread(&point.thread_id);
        }
        // A launch into a new worktree ends its setup when the agent starts, or when its
        // async setup script ends after that.
        let setups = &self.vcs.setups;
        if setups
            .get(&point.thread_id)
            .is_some_and(|s| s.phase == ProjectClonePhase::Running)
        {
            setups.agent_started(&point.thread_id);
        }
        Box::pin(std::future::ready(()))
    }

    /// The turn may have changed files: refresh the status the VCS streams show.
    fn turn_ended(&self, point: TurnPoint, _status: String) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            if let Some(cwd) = point.cwd {
                let _ = self.vcs.hub.refresh_local(&cwd).await;
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{methods::Deps, routes::mcp};
    use conn_engine::Engine;
    use serde_json::json;

    fn git(dir: &std::path::Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// T3's settle effect (`ThreadSettlementService.ts:725`) through the production path: the
    /// engine's `thread.settled` effect reaches the host, which closes the thread's terminals
    /// and runs the project's `runOnSettle` script in its worktree. The script runs once per
    /// settlement; after exit 0 its terminal closes, and a failed one keeps its terminal.
    #[tokio::test(flavor = "current_thread")]
    async fn a_settled_thread_runs_its_settle_script_through_the_host() {
        use conn_contract::{TerminalAttachStreamEvent as E, TerminalMetadataStreamEvent as M};
        let dir =
            std::env::temp_dir().join(format!("conn-host-settle-{}", conn_support::uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let (root, worktree) = (dir.join("repo"), dir.join("wt"));
        {
            let (root, worktree) = (root.clone(), worktree.clone());
            tokio::task::spawn_blocking(move || {
                std::fs::create_dir_all(&root).unwrap();
                git(&root, &["init", "-q", "-b", "main"]);
                git(
                    &root,
                    &[
                        "-c",
                        "user.name=Test",
                        "-c",
                        "user.email=test@example.invalid",
                        "-c",
                        "commit.gpgsign=false",
                        "commit",
                        "-q",
                        "--allow-empty",
                        "-m",
                        "init",
                    ],
                );
                git(
                    &root,
                    &[
                        "worktree",
                        "add",
                        "-q",
                        "-b",
                        "settle",
                        worktree.to_str().unwrap(),
                    ],
                );
            })
            .await
            .unwrap();
        }
        let environment =
            Arc::new(Environment::load(&dir, None, dir.clone(), Default::default()).unwrap());
        let script = |command: &str| {
            json!({"defaultProjectScripts":[{"id":"finish","name":"Finish","icon":"play",
                "command":command,"runOnSettle":true,"runOnWorktreeCreate":false}]})
        };
        environment
            .settings
            .update(script("printf 'ran\\n' >> settle-runs.txt"), None)
            .unwrap();
        let terminals = conn_terminal::TerminalManager::new(conn_terminal::TerminalConfig {
            shells: vec!["/bin/sh".into()],
            ..Default::default()
        });
        let host = Arc::new(Host {
            mcp: OnceLock::new(),
            files: None,
            vcs: VcsShared::default(),
            terminals: terminals.clone(),
            environment: environment.clone(),
            scheduled_tasks: OnceLock::new(),
            devices: OnceLock::new(),
        });
        let mut config = conn_engine::EngineConfig::new(dir.join("engine.sqlite"));
        config.projects = vec![conn_engine::ProjectConfig {
            title: "Project".into(),
            workspace_root: root.to_string_lossy().into_owned(),
        }];
        config.providers = vec![Arc::new(conn_engine::fake::FakeProvider::new(
            "claudeAgent",
        ))];
        config.host = Some(host.clone());
        let engine = Arc::new(conn_engine::SqliteEngine::open(config).unwrap());
        let service = mcp::service(&Deps {
            environment: Some(environment.clone()),
            engine: Some(engine.clone()),
            terminals: Some(terminals.clone()),
            ..Deps::default()
        })
        .unwrap();
        host.mcp.set(service.clone()).unwrap();
        let dispatch = |command: Value| {
            let engine = engine.clone();
            async move {
                engine
                    .dispatch(conn_contract::from_json(command).unwrap())
                    .await
                    .unwrap();
            }
        };
        let thread = "thread:settle";
        dispatch(json!({"type":"thread.create","commandId":"create","threadId":thread,
            "projectId":conn_engine::SqliteEngine::project_id_for(&root.to_string_lossy()),
            "title":"Settle","modelSelection":{"instanceId":"claudeAgent","model":"claude-haiku-5-5"},
            "runtimeMode":"auto","interactionMode":"default","branch":"settle",
            "worktreePath":worktree.to_string_lossy(),"createdBy":"user","creationSource":"web"}))
        .await;
        let settle = |n: u32| json!({"type":"thread.settle","commandId":format!("settle-{n}"),"threadId":thread});
        let mut metadata = terminals.subscribe_metadata();
        // The settle script's terminal appears, then goes after exit 0.
        dispatch(settle(1)).await;
        let wait = std::time::Duration::from_secs(30);
        let first = tokio::time::timeout(wait, async {
            loop {
                if let M::Upsert(upsert) = metadata.next().await
                    && upsert.terminal.terminal_id.starts_with("settle-finish-")
                {
                    return upsert.terminal.terminal_id;
                }
            }
        })
        .await
        .expect("the settle effect starts the project's settle script");
        tokio::time::timeout(wait, async {
            loop {
                if let M::Remove(removed) = metadata.next().await
                    && removed.terminal_id == first
                {
                    return;
                }
            }
        })
        .await
        .expect("the settle script's terminal closes after exit 0");
        // A settle of the settled thread keeps its settlement: no second run.
        dispatch(settle(2)).await;

        // A new settlement whose script fails keeps its terminal.
        dispatch(json!({"type":"thread.unsettle","commandId":"unsettle","threadId":thread,"reason":"user"})).await;
        environment
            .settings
            .update(script("printf 'FAILED-%s\\n' now; exit 3"), None)
            .unwrap();
        dispatch(settle(3)).await;
        let failed = loop {
            if let M::Upsert(upsert) = metadata.next().await
                && upsert.terminal.terminal_id.starts_with("settle-finish-")
                && upsert.terminal.terminal_id != first
            {
                break upsert.terminal.terminal_id;
            }
        };
        let mut output = terminals
            .observe(
                conn_contract::from_json(json!({"threadId":thread,"terminalId":failed})).unwrap(),
            )
            .unwrap();
        let mut text = String::new();
        let mut asked = false;
        while !text.contains("STILL-42") {
            match output.next().await {
                E::Output(event) => text.push_str(&event.data),
                E::Snapshot(event) => text.push_str(&event.snapshot.history),
                E::Closed(_) | E::Exited(_) => {
                    panic!("the failed script's terminal closed: {text}")
                }
                _ => {}
            }
            if !asked && text.contains("FAILED-now") {
                asked = true;
                terminals
                    .write(
                        conn_contract::from_json(json!({"threadId":thread,"terminalId":failed,
                            "data":"echo STILL-$((40+2))\r"}))
                        .unwrap(),
                        None,
                    )
                    .await
                    .unwrap();
            }
        }
        let runs = tokio::task::spawn_blocking({
            let file = worktree.join("settle-runs.txt");
            move || std::fs::read_to_string(file).unwrap()
        })
        .await
        .unwrap();
        assert_eq!(
            runs, "ran\n",
            "one run for the first settlement, none for its repeat"
        );
        terminals.shutdown().await;
        engine.shutdown().await;
        drop(host);
        drop(service);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// T3's launch preparation (`ThreadLaunchService.prepareInBackground`): a thread launched
    /// into a new worktree runs the project's `runOnWorktreeCreate` script in terminal
    /// `setup-<id>`. A script with `async: false` holds the launch until it exits; an async
    /// one (T3's default) runs on while the launch answers, and its stage records its end.
    #[tokio::test(flavor = "current_thread")]
    async fn a_worktree_launch_runs_the_setup_script_through_the_host() {
        use conn_contract::{
            ProjectClonePhase as Phase, WorktreeSetupStageId as Id, WorktreeSetupStageStatus as St,
        };
        let dir = std::env::temp_dir().join(format!("conn-host-setup-{}", conn_support::uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let root = dir.join("repo");
        {
            let root = root.clone();
            tokio::task::spawn_blocking(move || {
                std::fs::create_dir_all(&root).unwrap();
                git(&root, &["init", "-q", "-b", "main"]);
                git(
                    &root,
                    &[
                        "-c",
                        "user.name=Test",
                        "-c",
                        "user.email=test@example.invalid",
                        "-c",
                        "commit.gpgsign=false",
                        "commit",
                        "-q",
                        "--allow-empty",
                        "-m",
                        "init",
                    ],
                );
            })
            .await
            .unwrap();
        }
        let environment =
            Arc::new(Environment::load(&dir, None, dir.clone(), Default::default()).unwrap());
        let script = |command: &str, blocking: bool| {
            let mut script = json!({"id":"install","name":"Install","icon":"play",
                "command":command,"runOnWorktreeCreate":true});
            if blocking {
                script["async"] = json!(false);
            }
            json!({"defaultProjectScripts":[script]})
        };
        let terminals = conn_terminal::TerminalManager::new(conn_terminal::TerminalConfig {
            shells: vec!["/bin/sh".into()],
            ..Default::default()
        });
        let host = Arc::new(Host {
            mcp: OnceLock::new(),
            files: None,
            vcs: VcsShared::default(),
            terminals: terminals.clone(),
            environment: environment.clone(),
            scheduled_tasks: OnceLock::new(),
            devices: OnceLock::new(),
        });
        let mut config = conn_engine::EngineConfig::new(dir.join("engine.sqlite"));
        config.projects = vec![conn_engine::ProjectConfig {
            title: "Project".into(),
            workspace_root: root.to_string_lossy().into_owned(),
        }];
        config.providers = vec![Arc::new(conn_engine::fake::FakeProvider::new(
            "claudeAgent",
        ))];
        config.host = Some(host.clone());
        let engine = Arc::new(conn_engine::SqliteEngine::open(config).unwrap());
        let service = mcp::service(&Deps {
            environment: Some(environment.clone()),
            engine: Some(engine.clone()),
            terminals: Some(terminals.clone()),
            ..Deps::default()
        })
        .unwrap();
        host.mcp.set(service.clone()).unwrap();
        // No first message: no turn starts, so the launch itself ends the agent stage.
        let launch = |thread: &str, link_origin: Option<Value>| {
            let engine = engine.clone();
            let root = root.clone();
            let thread = thread.to_owned();
            async move {
                let mut input = json!({"commandId":format!("launch:{thread}"),"threadId":thread,
                    "projectId":conn_engine::SqliteEngine::project_id_for(&root.to_string_lossy()),
                    "title":"Setup","modelSelection":{"instanceId":"claudeAgent","model":"claude-haiku-5-5"},
                    "runtimeMode":"auto","interactionMode":"default",
                    "workspaceStrategy":{"type":"worktree","baseRef":"main","startFromOrigin":false},
                    "createdBy":"user","creationSource":"web"});
                if let Some(origin) = link_origin {
                    input["linkOrigin"] = origin;
                }
                let launched = engine.launch_thread(input).await;
                let Ok(launched) = launched else {
                    panic!(
                        "the launch fails: {:?}",
                        launched.err().map(|e| format!("{e:?}"))
                    );
                };
                PathBuf::from(
                    launched["projection"]["thread"]["worktreePath"]
                        .as_str()
                        .expect("the thread records its worktree"),
                )
            }
        };
        let exists = |path: PathBuf| async move {
            tokio::task::spawn_blocking(move || path.exists())
                .await
                .unwrap()
        };
        let stage = |thread: &str| {
            let snapshot = host.vcs.setups.get(thread).unwrap();
            let stage = snapshot
                .stages
                .iter()
                .find(|s| s.id == Id::SetupScript)
                .unwrap()
                .clone();
            (snapshot.setup_script.map(|s| s.terminal_id), stage)
        };

        // `async: false`: the launch answers after the script exited.
        environment
            .settings
            .update(
                script(
                    "printf '%s\\n' \"$T3CODE_PROJECT_ROOT\" > setup-ran.txt; printf 'INSTALLED-%s\\n' ok",
                    true,
                ),
                None,
            )
            .unwrap();
        let worktree = launch("thread:blocking", None).await;
        assert!(
            exists(worktree.join("setup-ran.txt")).await,
            "a blocking setup script finished before the launch answered"
        );
        assert_eq!(
            host.vcs.setups.get("thread:blocking").unwrap().phase,
            Phase::Done,
            "a launch with no first message ends its setup when it commits"
        );
        let (terminal, script_stage) = stage("thread:blocking");
        assert_eq!(terminal.as_deref(), Some("setup-install"));
        assert_eq!(script_stage.status, St::Done);
        assert_eq!(script_stage.detail.as_deref(), Some("exited with 0"));
        assert!(
            script_stage.tail.iter().any(|line| line == "INSTALLED-ok"),
            "{:?}",
            script_stage.tail
        );

        // T3's default (`async` unset): the launch answers while the script still runs.
        let gate = dir.join("go");
        environment
            .settings
            .update(
                script(
                    &format!(
                        "while [ ! -f '{}' ]; do sleep 0.1; done; printf done > async-ran.txt",
                        gate.display()
                    ),
                    false,
                ),
                None,
            )
            .unwrap();
        let mut watch = host.vcs.setups.subscribe("thread:async");
        let worktree = launch("thread:async", None).await;
        assert_eq!(stage("thread:async").1.status, St::Running);
        assert!(!exists(worktree.join("async-ran.txt")).await);
        let snapshot = host.vcs.setups.get("thread:async").unwrap();
        assert!(
            snapshot
                .stages
                .iter()
                .any(|s| s.id == Id::Agent && s.status == St::Done),
            "{:?}",
            snapshot.stages
        );
        assert_eq!(
            snapshot.phase,
            Phase::Running,
            "the setup waits for its async script"
        );
        tokio::task::spawn_blocking({
            let gate = gate.clone();
            move || std::fs::write(gate, "").unwrap()
        })
        .await
        .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(30), async {
            loop {
                if watch
                    .borrow_and_update()
                    .as_ref()
                    .is_some_and(|s| s.phase == Phase::Done)
                {
                    return;
                }
                watch.changed().await.unwrap();
            }
        })
        .await
        .expect("the async script's end finishes the setup");
        assert_eq!(
            stage("thread:async").1.detail.as_deref(),
            Some("exited with 0")
        );
        assert!(exists(worktree.join("async-ran.txt")).await);

        // `linkOriginIsFenced`: a thread a link below full access starts runs no script, and
        // an origin stamped before access was recorded counts as fenced.
        environment
            .settings
            .update(script("printf ran > fenced-ran.txt", true), None)
            .unwrap();
        for (thread, origin) in [
            (
                "thread:linked",
                json!({"sessionId":"s1","label":"Peer","access":"auto"}),
            ),
            (
                "thread:linked-old",
                json!({"sessionId":"s2","label":"Old peer"}),
            ),
        ] {
            let worktree = launch(thread, Some(origin)).await;
            assert!(!exists(worktree.join("fenced-ran.txt")).await, "{thread}");
            let (terminal, script_stage) = stage(thread);
            assert_eq!(
                (terminal, script_stage.status),
                (None, St::Skipped),
                "{thread}"
            );
            assert!(
                terminals.read(thread, "setup-install", None).is_none(),
                "{thread} opened no setup terminal"
            );
        }

        terminals.shutdown().await;
        engine.shutdown().await;
        drop(host);
        drop(service);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn browser_access_is_scoped_to_project_and_captured_at_session_start() {
        let dir =
            std::env::temp_dir().join(format!("conn-browser-access-{}", conn_support::uuid_v4()));
        let environment =
            Arc::new(Environment::load(&dir, None, dir.clone(), Default::default()).unwrap());
        let engine = Arc::new(
            conn_engine::SqliteEngine::open(conn_engine::EngineConfig::new(
                dir.join("engine.sqlite"),
            ))
            .unwrap(),
        );
        let service = mcp::service(&Deps {
            environment: Some(environment.clone()),
            engine: Some(engine.clone()),
            ..Deps::default()
        })
        .unwrap();
        let host = Host {
            mcp: OnceLock::new(),
            files: None,
            vcs: VcsShared::default(),
            terminals: crate::methods::terminal::manager(Some(&environment)),
            environment: environment.clone(),
            scheduled_tasks: OnceLock::new(),
            devices: OnceLock::new(),
        };
        host.mcp.set(service.clone()).unwrap();
        let issue = |project: Option<&str>| {
            let tools = host
                .agent_tools(AgentSession {
                    thread_id: "thread".into(),
                    project_id: project.map(str::to_owned),
                    provider_instance_id: "claudeAgent".into(),
                    subagent: false,
                })
                .unwrap();
            let authorization = &tools.servers[0].headers[0].1;
            service
                .resolve_thread_token(authorization.strip_prefix("Bearer ").unwrap())
                .unwrap()
        };
        assert!(issue(Some("p")).preview, "T3 defaults browser access on");
        environment.settings.update(json!({"enableAgentBrowserAccess":false,"projectSettingsOverrides":{"p":{"enableAgentBrowserAccess":true}}}),None).unwrap();
        let enabled = issue(Some("p"));
        let disabled = issue(Some("q"));
        assert!(enabled.preview);
        assert!(!disabled.preview);
        assert!(!issue(None).preview);
        environment.settings.update(json!({"enableAgentBrowserAccess":true,"projectSettingsOverrides":{"p":{"enableAgentBrowserAccess":false}}}),None).unwrap();
        assert!(!issue(Some("p")).preview);
        assert!(issue(Some("q")).preview);
        assert!(enabled.preview, "existing credential keeps its grant");
        assert!(
            !disabled.preview,
            "existing credential does not gain a grant"
        );
        engine.shutdown().await;
        drop(host);
        drop(service);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
