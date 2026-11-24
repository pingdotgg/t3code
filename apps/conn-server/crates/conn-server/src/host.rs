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
    /// Wakes the automatic settlement sweep: a settlement can free a parent's delegates.
    pub settlement_wake: Arc<tokio::sync::Notify>,
    /// Compacts idle Claude threads before their prompt cache expires.
    pub idle_compaction: OnceLock<Arc<crate::idle_compaction::IdleCompaction>>,
    /// Set once the engine exists; a deleted thread or a stopped session may free a worktree.
    pub worktree_cleanup: OnceLock<crate::worktree_cleanup::WorktreeCleanup>,
    /// Preview tabs a deleted thread held (`ResourceCleanupService.cleanupPreviews`).
    pub previews: OnceLock<conn_preview::tabs::Preview>,
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

/// `managedWorktreesDirectories` (T3 `worktreesDirectory.ts`): `<state-dir>/worktrees`, the
/// `worktreesDirectory` setting and the `previousWorktreesDirectories` it remembers, each with
/// `~` expanded; a relative setting or a filesystem root names none.
pub fn managed_worktree_dirs(environment: &Environment) -> Vec<PathBuf> {
    let settings = environment.settings.raw();
    let default = environment.state_dir.join("worktrees");
    let previous = settings
        .get("previousWorktreesDirectories")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str);
    let configured = settings.get("worktreesDirectory").and_then(Value::as_str);
    let mut dirs = vec![default.clone()];
    for setting in configured.into_iter().chain(previous).map(str::trim) {
        let dir = if setting.is_empty() {
            default.clone()
        } else {
            conn_files::paths::normalize(std::path::Path::new(
                &conn_provider_support::instance::expand_home(setting),
            ))
        };
        if dir.is_absolute() && dir.parent().is_some() && !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}

/// `isManagedWorktreePath`: an absolute, normalized path exactly two levels below a managed
/// folder (`<dir>/<repo>/<name>`), compared after symlinks resolve as Git resolves them.
/// Blocking: it reads the filesystem.
pub fn is_managed_worktree_path(dirs: &[PathBuf], path: &std::path::Path) -> bool {
    if !path.is_absolute() || conn_files::paths::normalize(path) != path {
        return false;
    }
    let candidate = real_location(path);
    dirs.iter().map(|dir| real_location(dir)).any(|root| {
        root.parent().is_some()
            && candidate
                .strip_prefix(&root)
                .is_ok_and(|rest| rest.components().count() == 2)
    })
}

/// The nearest existing ancestor's real path, plus the missing components.
fn real_location(path: &std::path::Path) -> PathBuf {
    if let Ok(real) = std::fs::canonicalize(path) {
        return real;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => real_location(parent).join(name),
        _ => path.to_owned(),
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
    fn refresh_settings(&self) -> BoxFuture<'_, ()> {
        Box::pin(crate::settings::refresh(&self.environment))
    }

    fn provider_instance_enabled(&self, project_id: Option<&str>, instance_id: &str) -> bool {
        // T3 admits no launch while its settings fail to load; a retry runs first
        // (`refresh_settings`), so this holds only while the failure lasts.
        if self.environment.settings.needs_reload() {
            return false;
        }
        crate::settings::provider_instance_enabled(
            &self.environment.settings.raw(),
            project_id,
            instance_id,
        )
    }

    fn queue_instance_enabled(&self, project_id: Option<&str>, instance_id: &str) -> bool {
        self.environment
            .settings
            .queue_instance_enabled(project_id, instance_id)
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

    fn session_released(&self) {
        if let Some(cleanup) = self.worktree_cleanup.get() {
            cleanup.session_closed();
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
            let submodules = crate::settings::worktree_submodules(
                &self.environment.settings.raw(),
                request.project_id.as_deref(),
            );
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
                    submodules,
                    missing_base: request.missing_base,
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

    fn cancel_preparation(&self, thread_id: &str) {
        self.vcs.setups.cancel(thread_id);
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
    ) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let root = PathBuf::from(project_root);
            let path = PathBuf::from(&worktree.path);
            let discarded = conn_vcs::worktree::discard(&root, &path, &worktree.branch)
                .await
                .map_err(|e| e.to_string());
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
                let reason = match &discarded {
                    Ok(()) => reason,
                    Err(error) => format!(
                        "{reason} The worktree at {} could not be removed: {error}",
                        worktree.path
                    ),
                };
                self.vcs
                    .setups
                    .finish(&thread_id, ProjectClonePhase::Failed, Some(&reason));
            }
            discarded
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

    fn thread_closed(
        &self,
        thread_id: &str,
        reason: ThreadClose,
    ) -> BoxFuture<'_, Result<(), String>> {
        match &reason {
            // `settleActionRunAt`: the script runs once per settlement, so only on the
            // transition to settled.
            ThreadClose::Settled { settled_at } => {
                self.clean_up_settled(thread_id, Some(settled_at.clone()), true);
                return Box::pin(std::future::ready(Ok(())));
            }
            ThreadClose::SettledAgain { settled_at } => {
                self.clean_up_settled(thread_id, Some(settled_at.clone()), false);
                return Box::pin(std::future::ready(Ok(())));
            }
            // Its settle script may have run already: the terminals close for the thread's
            // current settlement, and no script runs.
            ThreadClose::SettledUnnamed => {
                self.clean_up_settled(thread_id, None, false);
                return Box::pin(std::future::ready(Ok(())));
            }
            ThreadClose::Archived | ThreadClose::Deleted => {
                // A closed thread compacts nothing: its waiting timer ends now.
                if let Some(idle) = self.idle_compaction.get() {
                    idle.cancel(thread_id);
                }
            }
        }
        let deleted = reason == ThreadClose::Deleted;
        // `ThreadDeletion`'s `preview.cleanup`: a deleted thread's tabs free their slots.
        if deleted && let Some(previews) = self.previews.get().cloned() {
            let thread_id = thread_id.to_owned();
            tokio::spawn(async move {
                if let Err(error) = previews.close(&thread_id, None).await {
                    eprintln!("preview cleanup: {error}");
                }
            });
        }
        if reason == ThreadClose::Deleted
            && let Some(cleanup) = self.worktree_cleanup.get()
        {
            cleanup.thread_deleted();
        }
        let terminals = self.terminals.clone();
        // The thread's device sessions end; the devices stay on for other threads.
        let devices = self.devices.get().cloned();
        // `ResourceCleanupService`: a deleted thread takes the tasks bound to it.
        let tasks = deleted
            .then(|| self.scheduled_tasks.get().cloned())
            .flatten();
        let thread_id = thread_id.to_owned();
        Box::pin(async move {
            // Each step runs whatever the others did; their errors come back together, so the
            // close is tried again (`ResourceCleanupService`).
            let mut errors = vec![];
            // T3's `terminal.cleanup` effect: archive and delete both drop the history. The
            // close scans and unlinks history files under the manager's lock: off the runtime.
            let closing = thread_id.clone();
            let terminals = tokio::task::spawn_blocking(move || {
                terminals.close(TerminalCloseInput {
                    thread_id: closing,
                    terminal_id: None,
                    delete_history: Some(true),
                });
            })
            .await;
            if let Err(e) = terminals {
                errors.push(format!("closing the thread's terminals stopped: {e}"));
            }
            if let Some(tasks) = tasks
                && let Err(e) = tasks.delete_for_thread(&thread_id).await
            {
                errors.push(format!("deleting the thread's scheduled tasks: {e}"));
            }
            if let Some(devices) = devices {
                match tokio::time::timeout(
                    DEVICE_RELEASE_DEADLINE,
                    devices.cleanup_thread(&thread_id),
                )
                .await
                {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => {
                        errors.push(format!("releasing the thread's devices: {}", e.message()));
                    }
                    Err(_) => errors.push(format!(
                        "releasing the thread's devices took over {} s",
                        DEVICE_RELEASE_DEADLINE.as_secs()
                    )),
                }
            }
            if errors.is_empty() {
                Ok(())
            } else {
                Err(errors.join("; "))
            }
        })
    }
}

/// How long a closed thread's device release may take, all devices together. T3 lets a worker
/// reclaim its slot from an effect after 30 s.
const DEVICE_RELEASE_DEADLINE: std::time::Duration = std::time::Duration::from_secs(30);

impl Host {
    /// `cleanUpSettledThread` (`ThreadSettlementService.ts:700`) for the committed settlement
    /// named by `settled_at`, one cleanup at a time. While that settlement is still the
    /// thread's, `closeOnSettle` closes its `stopOnSettle` terminals and then every idle one;
    /// then a new settlement (`first`) runs the project's settle script in the worktree.
    /// Without `settled_at`, the thread's current settlement is the one. The settlement sweep
    /// wakes after it, even when the settlement is no longer current.
    fn clean_up_settled(&self, thread_id: &str, settled_at: Option<String>, first: bool) {
        let (terminals, mcp) = (self.terminals.clone(), self.mcp.get().cloned());
        let cleanups = self.settle_cleanups.clone();
        let thread_id = thread_id.to_owned();
        let wake = self.settlement_wake.clone();
        tokio::spawn(async move {
            let _one_at_a_time = cleanups.lock().await;
            async {
                let settled_at = match (settled_at, &mcp) {
                    (Some(settled_at), _) => settled_at,
                    (None, Some(mcp)) => match mcp.current_settlement(&thread_id).await {
                        Some(settled_at) => settled_at,
                        None => return,
                    },
                    (None, None) => String::new(),
                };
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
            }
            .await;
            // A settlement can free a parent's delegates (`ThreadSettlementService.ts:752`).
            wake.notify_one();
        });
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
    fn turn_ended(&self, point: TurnPoint, status: String) -> BoxFuture<'_, ()> {
        // `IdleCompactionService`: a completed run starts its thread's timer over.
        if status == "completed"
            && let Some(idle) = self.idle_compaction.get()
        {
            idle.run_completed(&point.thread_id, &point.run_id);
        }
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

    /// `IdleCompactionService` through the production path: the engine's turn end reaches the
    /// host, whose timer sends `/compact` two minutes before the cache expires, on a clock the
    /// test moves. Without the host's hook no compaction runs.
    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn a_completed_turn_reaches_idle_compaction_through_the_host() {
        use std::time::Duration;
        let dir = std::env::temp_dir().join(format!("conn-host-idle-{}", conn_support::uuid_v4()));
        std::fs::create_dir_all(dir.join("project")).unwrap();
        let root = dir.join("project").to_string_lossy().into_owned();
        let environment =
            Arc::new(Environment::load(&dir, None, dir.clone(), Default::default()).unwrap());
        environment
            .settings
            .update(json!({"idleCompaction": "beforeCacheExpires"}), None)
            .unwrap();
        let host = Arc::new(Host {
            mcp: OnceLock::new(),
            files: None,
            vcs: VcsShared::default(),
            terminals: crate::methods::terminal::manager(Some(&environment)),
            environment: environment.clone(),
            scheduled_tasks: OnceLock::new(),
            devices: OnceLock::new(),
            previews: OnceLock::new(),
            settle_cleanups: Arc::default(),
            settlement_wake: Arc::default(),
            idle_compaction: OnceLock::new(),
            worktree_cleanup: OnceLock::new(),
        });
        let t0 = 1_800_000_000_000_u64;
        let clock = Arc::new(conn_engine::ManualClock::at(t0));
        let mut config = conn_engine::EngineConfig::new(dir.join("engine.sqlite"));
        config.projects = vec![conn_engine::ProjectConfig {
            title: "Project".into(),
            workspace_root: root.clone(),
        }];
        config.providers = vec![Arc::new(conn_engine::fake::FakeProvider::new(
            "claudeAgent",
        ))];
        config.host = Some(host.clone());
        config.turn_observer = Some(host.clone());
        config.clock = clock.clone();
        let engine = Arc::new(conn_engine::SqliteEngine::open(config).unwrap());
        let _ = host
            .idle_compaction
            .set(crate::idle_compaction::IdleCompaction::new(
                engine.clone(),
                environment.clone(),
            ));
        let expires = conn_support::time::iso_from_millis(i64::try_from(t0 + 10 * 60_000).unwrap());
        for command in [
            json!({"type":"thread.create","commandId":"create","threadId":"thread",
                "projectId":conn_engine::SqliteEngine::project_id_for(&root),"title":"Idle",
                "modelSelection":{"instanceId":"claudeAgent","model":"claude-haiku-5-5"},
                "runtimeMode":"auto","interactionMode":"default","branch":null,"worktreePath":null,
                "createdBy":"user","creationSource":"web"}),
            json!({"type":"message.dispatch","commandId":"send","threadId":"thread",
                "messageId":"message-1","text":format!("large-context:{expires}"),"attachments":[],
                "dispatchMode":{"type":"start_immediately"},"createdBy":"user","creationSource":"web"}),
        ] {
            engine
                .dispatch(conn_contract::from_json(command).unwrap())
                .await
                .unwrap();
        }
        let run_of = |message: String| {
            let engine = engine.clone();
            async move {
                for _ in 0..500 {
                    let p = engine.get_thread_projection("thread".into()).await.unwrap();
                    if let Some(run) = p["runs"].as_array().and_then(|runs| {
                        runs.iter().find(|r| {
                            r["userMessageId"] == message.as_str() && r["status"] == "completed"
                        })
                    }) {
                        return run["id"].as_str().unwrap().to_owned();
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                panic!("no completed run for {message}");
            }
        };
        let run = run_of("message-1".into()).await;
        let step = Duration::from_secs(8 * 60 + 1);
        clock.advance(step);
        tokio::time::advance(step).await;
        run_of(format!("idle-compact:thread:{run}")).await;

        // An archived or deleted thread's waiting timer ends at once, long before its deadline.
        let idle = host.idle_compaction.get().unwrap().clone();
        let expires = conn_support::time::iso_from_millis(
            i64::try_from(t0 + step.as_millis() as u64 + 10 * 60_000).unwrap(),
        );
        for (thread, close) in [("archived", "thread.archive"), ("deleted", "thread.delete")] {
            for command in [
                json!({"type":"thread.create","commandId":format!("create-{thread}"),"threadId":thread,
                    "projectId":conn_engine::SqliteEngine::project_id_for(&root),"title":thread,
                    "modelSelection":{"instanceId":"claudeAgent","model":"claude-haiku-5-5"},
                    "runtimeMode":"auto","interactionMode":"default","branch":null,
                    "worktreePath":null,"createdBy":"user","creationSource":"web"}),
                json!({"type":"message.dispatch","commandId":format!("send-{thread}"),
                    "threadId":thread,"messageId":format!("message-{thread}"),
                    "text":format!("large-context:{expires}"),"attachments":[],
                    "dispatchMode":{"type":"start_immediately"},"createdBy":"user",
                    "creationSource":"web"}),
            ] {
                engine
                    .dispatch(conn_contract::from_json(command).unwrap())
                    .await
                    .unwrap();
            }
            let mut waited = 0;
            while !idle.waiting(thread) {
                assert!(waited < 500, "{thread}: no timer");
                waited += 1;
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            engine
                .dispatch(
                    conn_contract::from_json(
                        json!({"type":close,"commandId":format!("close-{thread}"),"threadId":thread}),
                    )
                    .unwrap(),
                )
                .await
                .unwrap();
            for _ in 0..500 {
                if !idle.waiting(thread) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(!idle.waiting(thread), "{close} cancels the waiting timer");
        }
        engine.shutdown().await;
        drop(host);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn cleanup_host(dir: &std::path::Path) -> Host {
        let environment =
            Arc::new(Environment::load(dir, None, dir.to_path_buf(), Default::default()).unwrap());
        let terminals = TerminalManager::new(conn_terminal::TerminalConfig {
            history_dir: Some(dir.join("terminals")),
            shells: vec!["/bin/sh".into()],
            poll_interval: std::time::Duration::from_millis(50),
            kill_grace: std::time::Duration::from_millis(500),
            persist_delay: std::time::Duration::from_millis(10),
            ..conn_terminal::TerminalConfig::default()
        });
        Host {
            mcp: OnceLock::new(),
            files: None,
            vcs: VcsShared::default(),
            terminals,
            environment,
            scheduled_tasks: OnceLock::new(),
            devices: OnceLock::new(),
            previews: OnceLock::new(),
            settle_cleanups: Arc::default(),
            settlement_wake: Arc::default(),
            idle_compaction: OnceLock::new(),
            worktree_cleanup: OnceLock::new(),
        }
    }

    fn attach(thread: &str, terminal: &str) -> conn_contract::TerminalAttachInput {
        conn_contract::TerminalAttachInput {
            thread_id: thread.into(),
            terminal_id: terminal.into(),
            cwd: Some(std::env::temp_dir().to_string_lossy().into_owned()),
            worktree_path: None,
            cols: None,
            rows: None,
            env: Some(conn_contract::support::Map::from([
                ("PS1".to_owned(), "$ ".to_owned()),
                ("HISTFILE".to_owned(), "/dev/null".to_owned()),
            ])),
            provider_instance_id: None,
            stop_on_settle: None,
            restart_if_not_running: None,
            resume: None,
            max_history_bytes: None,
        }
    }

    /// The text a fresh attachment replays.
    async fn replayed(host: &Host, thread: &str, terminal: &str) -> (String, Option<i64>) {
        use conn_contract::TerminalAttachStreamEvent as E;
        let mut sub = host.terminals.attach(attach(thread, terminal), 1).unwrap();
        let E::Snapshot(s) = sub.next().await else {
            panic!("an attachment starts with its snapshot")
        };
        (s.snapshot.history, s.snapshot.pid)
    }

    async fn print_marker(host: &Host, thread: &str, terminal: &str, marker: &str) -> i64 {
        use conn_contract::TerminalAttachStreamEvent as E;
        let mut sub = host.terminals.attach(attach(thread, terminal), 1).unwrap();
        host.terminals
            .write(
                conn_contract::TerminalWriteInput {
                    thread_id: thread.into(),
                    terminal_id: terminal.into(),
                    data: format!("printf '%s-%s\\n' {marker} seen\n"),
                    binary: None,
                    reply: None,
                },
                None,
            )
            .await
            .unwrap();
        let wanted = format!("{marker}-seen");
        let mut all = String::new();
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            while !all.contains(&wanted) {
                match sub.next().await {
                    E::Output(o) => all.push_str(&o.data),
                    E::Snapshot(s) => all.push_str(&s.snapshot.history),
                    _ => {}
                }
            }
        })
        .await
        .expect("the marker reaches the terminal");
        host.terminals
            .read(thread, terminal, None)
            .and_then(|s| s.pid)
            .unwrap()
    }

    fn alive(pid: i64) -> bool {
        i32::try_from(pid)
            .ok()
            .and_then(rustix::process::Pid::from_raw)
            .is_some_and(|pid| rustix::process::test_kill_process(pid).is_ok())
    }

    /// T3's archive effect (`terminal.cleanup`) closes with `deleteHistory`: after unarchive,
    /// both named terminals reopen as new shells with clean scrollback.
    #[tokio::test(flavor = "current_thread")]
    async fn archive_stops_terminals_and_drops_their_scrollback() {
        let dir =
            std::env::temp_dir().join(format!("conn-archive-terms-{}", conn_support::uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let host = cleanup_host(&dir);
        let first = print_marker(&host, "archived", "term-1", "archmarkone").await;
        let second = print_marker(&host, "archived", "term-2", "archmarktwo").await;
        let other = print_marker(&host, "other", "term-1", "othermarker").await;

        host.thread_closed("archived", ThreadClose::Archived)
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            while alive(first) || alive(second) {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("archive stops both shells");

        for (terminal, old) in [("term-1", first), ("term-2", second)] {
            let (history, pid) = replayed(&host, "archived", terminal).await;
            assert!(
                pid.is_some_and(|pid| pid != old),
                "{terminal} is a new shell"
            );
            assert!(!history.contains("archmarkone-seen"), "{history:?}");
            assert!(!history.contains("archmarktwo-seen"), "{history:?}");
        }
        // Another thread's terminal keeps running with its scrollback.
        let (history, pid) = replayed(&host, "other", "term-1").await;
        assert_eq!(pid, Some(other));
        assert!(history.contains("othermarker-seen"), "{history:?}");
        host.terminals.shutdown().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Archive drops the history on the blocking pool: with the terminal manager's lock held,
    /// another RPC still completes on the server's one runtime thread.
    #[tokio::test(flavor = "current_thread")]
    async fn archive_cleanup_leaves_the_runtime_thread_free() {
        use crate::table::{CallContext, Handler, MethodTable};
        let dir =
            std::env::temp_dir().join(format!("conn-archive-blocking-{}", conn_support::uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let host = cleanup_host(&dir);
        let mut table = MethodTable::new();
        crate::methods::server::register(&mut table, &Deps::default());
        let Some(Handler::Unary(probe)) = table.get("server.probe") else {
            panic!("server.probe")
        };
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        let terminals = host.terminals.clone();
        let holder = std::thread::spawn(move || {
            let _held = terminals.hold_lock();
            held_tx.send(()).unwrap();
            // A stalled runtime fails the test after 10 s instead of hanging it.
            done_rx
                .recv_timeout(std::time::Duration::from_secs(10))
                .is_ok()
        });
        held_rx.recv().unwrap();
        // The close waits for the lock while the RPC runs.
        let (closed, ()) = tokio::join!(
            host.thread_closed("archived", ThreadClose::Archived),
            async {
                probe(CallContext::default(), json!({})).await.unwrap();
                let _ = done_tx.send(());
            }
        );
        closed.unwrap();
        assert!(
            holder.join().unwrap(),
            "the RPC completed while history cleanup held the lock"
        );
        host.terminals.shutdown().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// T3's deletion effect (`preview.cleanup`) frees the deleted thread's desktop tabs: the
    /// other thread's tabs stay, a full registry takes a new tab, and a replay is harmless.
    #[tokio::test(flavor = "current_thread")]
    async fn delete_closes_the_threads_desktop_previews() {
        let dir =
            std::env::temp_dir().join(format!("conn-delete-previews-{}", conn_support::uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let host = cleanup_host(&dir);
        let previews = conn_preview::tabs::Preview::new(dir.clone());
        host.previews.set(previews.clone()).unwrap();
        let kept = previews.open_desktop("kept", &json!({})).unwrap();
        while previews.open_desktop("deleted", &json!({})).is_ok() {}
        previews
            .open_desktop("newcomer", &json!({}))
            .expect_err("the registry is full");

        let sessions = |thread: &str| {
            previews.list(thread)["sessions"]
                .as_array()
                .map_or(0, Vec::len)
        };
        for _ in 0..2 {
            host.thread_closed("deleted", ThreadClose::Deleted)
                .await
                .unwrap();
            for _ in 0..100 {
                if sessions("deleted") == 0 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        }
        assert_eq!(sessions("deleted"), 0);
        assert_eq!(previews.list("kept")["sessions"][0]["tabId"], kept["tabId"]);
        previews.open_desktop("newcomer", &json!({})).unwrap();
        host.terminals.shutdown().await;
        let _ = std::fs::remove_dir_all(dir);
    }

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
            previews: OnceLock::new(),
            settle_cleanups: Arc::default(),
            settlement_wake: Arc::default(),
            idle_compaction: OnceLock::new(),
            worktree_cleanup: OnceLock::new(),
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
        let service = mcp::service(
            &Deps {
                environment: Some(environment.clone()),
                engine: Some(engine.clone()),
                terminals: Some(terminals.clone()),
                ..Deps::default()
            },
            "127.0.0.1:9".parse().unwrap(),
        )
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
            previews: OnceLock::new(),
            settle_cleanups: Arc::default(),
            worktree_cleanup: OnceLock::new(),
            settlement_wake: Arc::default(),
            idle_compaction: OnceLock::new(),
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
        // The launches here start no agent, so no agent reaches this address.
        let service = mcp::service(
            &Deps {
                environment: Some(environment.clone()),
                engine: Some(engine.clone()),
                terminals: Some(terminals.clone()),
                ..Deps::default()
            },
            ([127, 0, 0, 1], 0).into(),
        )
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
        let service = mcp::service(
            &Deps {
                environment: Some(environment.clone()),
                engine: Some(engine.clone()),
                ..Deps::default()
            },
            "127.0.0.1:9".parse().unwrap(),
        )
        .unwrap();
        let host = Host {
            mcp: OnceLock::new(),
            files: None,
            vcs: VcsShared::default(),
            terminals: crate::methods::terminal::manager(Some(&environment)),
            environment: environment.clone(),
            scheduled_tasks: OnceLock::new(),
            devices: OnceLock::new(),
            worktree_cleanup: OnceLock::new(),
            previews: OnceLock::new(),
            settle_cleanups: Arc::default(),
            settlement_wake: Arc::default(),
            idle_compaction: OnceLock::new(),
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

    /// `thread`'s stream, from now on.
    async fn subscribe(
        engine: &dyn Engine,
        thread: &str,
    ) -> conn_engine::Subscription<
        conn_contract::ThreadStreamItem,
        conn_contract::GetThreadProjectionError,
    > {
        engine
            .subscribe_thread(conn_contract::from_json(json!({"threadId": thread})).unwrap())
            .await
            .unwrap()
    }

    /// A run a previous process left active continues at start, and its new session gets
    /// `/mcp` at the address the server listens on. The session keeps that URL, so a guess
    /// fails every Conn tool call until the session is replaced.
    #[tokio::test(flavor = "current_thread")]
    async fn a_run_recovered_at_start_gets_the_listen_address() {
        let dir =
            std::env::temp_dir().join(format!("conn-recovered-mcp-{}", conn_support::uuid_v4()));
        let environment =
            Arc::new(Environment::load(&dir, None, dir.clone(), Default::default()).unwrap());
        let root = dir.to_string_lossy().into_owned();
        let config = |provider: &Arc<conn_engine::fake::FakeProvider>| {
            let mut config = conn_engine::EngineConfig::new(dir.join("engine.sqlite"));
            config.projects = vec![conn_engine::ProjectConfig {
                title: "P".into(),
                workspace_root: root.clone(),
            }];
            let provider: Arc<dyn conn_provider::Provider> = provider.clone();
            config.provider_set = Some(conn_provider::ProviderSet::from(vec![provider]));
            config
        };
        let thread = "thread:recovered";

        // The previous process stops during a turn, as on SIGTERM.
        let previous = conn_engine::SqliteEngine::open(config(&Arc::new(
            conn_engine::fake::FakeProvider::new("claudeAgent"),
        )))
        .unwrap();
        previous
            .launch_thread(json!({
                "commandId": "launch", "threadId": thread,
                "projectId": conn_engine::SqliteEngine::project_id_for(&root),
                "title": "Agent", "runtimeMode": "full-access", "interactionMode": "default",
                "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-5-5"},
                "workspaceStrategy": {"type": "root"},
            }))
            .await
            .unwrap();
        let mut stream = subscribe(&previous, thread).await;
        previous
            .dispatch(
                conn_contract::from_json(json!({
                    "type": "message.dispatch", "commandId": "hang", "threadId": thread,
                    "messageId": "message:hang", "text": "hang", "attachments": [],
                    "dispatchMode": {"type": "start_immediately"},
                    "createdBy": "user", "creationSource": "web",
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        while conn_contract::to_json(&stream.recv().await.unwrap().unwrap())["event"]["type"]
            != "provider-turn.updated"
        {}
        previous.begin_shutdown();
        previous.shutdown().await;
        // The store's lock goes with the engine.
        drop(previous);

        // The next start, in `serve`'s order.
        let host = Arc::new(Host {
            mcp: OnceLock::new(),
            files: None,
            vcs: VcsShared::default(),
            terminals: crate::methods::terminal::manager(Some(&environment)),
            environment: environment.clone(),
            scheduled_tasks: OnceLock::new(),
            previews: OnceLock::new(),
            devices: OnceLock::new(),
            settle_cleanups: Arc::default(),
            settlement_wake: Arc::default(),
            idle_compaction: OnceLock::new(),
            worktree_cleanup: OnceLock::new(),
        });
        let provider = Arc::new(conn_engine::fake::FakeProvider::new("claudeAgent"));
        let mut config = config(&provider);
        config.host = Some(host.clone());
        config.hold_effects = true;
        let engine = Arc::new(conn_engine::SqliteEngine::open(config).unwrap());
        let mut stream = subscribe(engine.as_ref(), thread).await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut deps = Deps {
            environment: Some(environment.clone()),
            engine: Some(engine.clone()),
            ..Deps::default()
        };
        crate::serve::start_agent_tools(&mut deps, &host, &engine, address);
        let opened = || provider.sessions.load(std::sync::atomic::Ordering::SeqCst) > 0;
        while !opened() {
            stream.recv().await.unwrap().unwrap();
        }

        let servers = provider.mcp_servers.lock().unwrap().clone();
        assert_eq!(
            servers.iter().map(|s| s.url.clone()).collect::<Vec<_>>(),
            [format!("http://{address}/mcp")],
            "the recovered session's `/mcp`"
        );
        engine.shutdown().await;
        std::fs::remove_dir_all(dir).unwrap();
    }
}
