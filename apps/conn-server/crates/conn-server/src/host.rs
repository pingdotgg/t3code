//! The server's services as the engine sees them ([`conn_engine::EngineHost`] and
//! [`conn_engine::TurnObserver`]): `/mcp` credentials per provider session, attachment claims,
//! worktrees, terminals that close with their thread, and VCS status after a turn.

use std::{
    path::PathBuf,
    sync::{Arc, OnceLock},
};

use conn_contract::{
    ChatAttachment, ProjectClonePhase, TerminalCloseInput, WorktreeSetupStageId,
    WorktreeSetupStageStatus, from_json, to_json,
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
    /// Settled-thread cleanups run one at a time, as T3's single event consumer runs them.
    pub settle_cleanups: Arc<tokio::sync::Mutex<()>>,
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
                    setup_script: None,
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
        match &reason {
            // `settleActionRunAt`: the script runs once per settlement, so only on the
            // transition to settled.
            ThreadClose::Settled { settled_at } => {
                self.clean_up_settled(thread_id, settled_at.clone(), true);
            }
            ThreadClose::SettledAgain { settled_at } => {
                self.clean_up_settled(thread_id, settled_at.clone(), false);
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

impl Host {
    /// `cleanUpSettledThread` (`ThreadSettlementService.ts:700`) for the committed settlement
    /// named by `settled_at`, one cleanup at a time. While that settlement is still the
    /// thread's, `closeOnSettle` closes its `stopOnSettle` terminals and then every idle one;
    /// then a new settlement (`first`) runs the project's settle script in the worktree.
    fn clean_up_settled(&self, thread_id: &str, settled_at: String, first: bool) {
        let (terminals, mcp) = (self.terminals.clone(), self.mcp.get().cloned());
        let cleanups = self.settle_cleanups.clone();
        let thread_id = thread_id.to_owned();
        tokio::spawn(async move {
            let _one_at_a_time = cleanups.lock().await;
            if let Some(mcp) = &mcp
                && !mcp.is_current_settlement(&thread_id, &settled_at).await
            {
                return;
            }
            terminals.close_on_settle(&thread_id);
            terminals.close_idle(&thread_id, None).await;
            if first && let Some(mcp) = mcp {
                mcp.run_settle_script(&thread_id, &settled_at).await;
            }
        });
    }
}

impl TurnObserver for Host {
    fn turn_started(&self, point: TurnPoint) -> BoxFuture<'_, ()> {
        if let Some(mcp) = self.mcp.get() {
            mcp.touch_thread(&point.thread_id);
        }
        // A launch into a new worktree ends its setup when the agent starts.
        let setups = &self.vcs.setups;
        if setups
            .get(&point.thread_id)
            .is_some_and(|s| s.phase == ProjectClonePhase::Running)
        {
            setups.mark_uncancellable(&point.thread_id);
            setups.stage_status(
                &point.thread_id,
                WorktreeSetupStageId::Agent,
                WorktreeSetupStageStatus::Done,
                None,
            );
            setups.finish(&point.thread_id, ProjectClonePhase::Done, None);
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
            settle_cleanups: Arc::default(),
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
        // Cleanups run one at a time, and each acts only while its settlement is the thread's:
        // held back, a settlement undone and replaced runs nothing, its replacement once.
        environment
            .settings
            .update(script("printf 'again\\n' >> settle-runs.txt"), None)
            .unwrap();
        let unsettle = |n: u32| json!({"type":"thread.unsettle","commandId":format!("unsettle-{n}"),"threadId":thread,"reason":"user"});
        dispatch(unsettle(2)).await;
        let held = host.settle_cleanups.lock().await;
        dispatch(settle(4)).await;
        dispatch(unsettle(3)).await;
        dispatch(settle(5)).await;
        drop(held);
        let last = tokio::time::timeout(wait, async {
            loop {
                if let M::Upsert(upsert) = metadata.next().await
                    && upsert.terminal.terminal_id.starts_with("settle-finish-")
                    && ![&first, &failed].contains(&&upsert.terminal.terminal_id)
                {
                    return upsert.terminal.terminal_id;
                }
            }
        })
        .await
        .expect("the current settlement runs its script");
        tokio::time::timeout(wait, async {
            loop {
                if let M::Remove(removed) = metadata.next().await
                    && removed.terminal_id == last
                {
                    return;
                }
            }
        })
        .await
        .expect("its terminal closes after exit 0");
        let runs = tokio::task::spawn_blocking({
            let file = worktree.join("settle-runs.txt");
            move || std::fs::read_to_string(file).unwrap()
        })
        .await
        .unwrap();
        assert_eq!(
            runs, "ran\nagain\n",
            "one run per settlement: none for a repeat or for a settlement undone since"
        );
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
            settle_cleanups: Arc::default(),
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
