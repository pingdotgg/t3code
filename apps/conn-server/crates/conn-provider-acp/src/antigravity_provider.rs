//! [`AntigravityProvider`]: one Antigravity instance (`AntigravityDriver.create`). Its sessions
//! run on the shared ACP runtime with the [`ANTIGRAVITY`](crate::ANTIGRAVITY) flavor; each
//! agent process gets its own temp folder under the instance's runtime temp folder, removed
//! after the process ends.
//!
//! The settings are fixed per provider: the server builds a new provider when the instance's
//! entry changes (`conn_server::instances`), as T3 rebuilds the instance.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use conn_contract::{ProviderCapabilities, ProviderInstanceId, from_json, to_json};
use conn_provider::{
    BoxFuture, OpenSessionInput, OpenedSession, Provider, ProviderError, ProviderResult,
};
use conn_provider_support::ids::{Env, SystemEnv};
use conn_provider_support::process::{LaunchSpec, Process};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::antigravity::{self, AntigravitySettings, Directories, Observed};
use crate::session::{self, AcpSession};
use crate::{ANTIGRAVITY, MAX_LINE_BYTES, lock, stop_process};

/// Where an Antigravity instance keeps its state.
#[derive(Clone, Debug)]
pub struct AntigravityConfig {
    /// The server's state folder (`host.paths.stateDir`): the profile lives below it.
    pub state_dir: PathBuf,
    /// Where `conn-files` saves attachments (`additionalDirectories`, file reads).
    pub attachments_dir: Option<PathBuf>,
    /// This server's executable: the stdio MCP bridge and the browser helper. `None`: the
    /// running executable.
    pub self_command: Option<String>,
}

pub struct AntigravityProvider {
    instance_id: ProviderInstanceId,
    settings: AntigravitySettings,
    config: AntigravityConfig,
    dirs: Directories,
    observed: std::sync::Mutex<Observed>,
}

impl std::fmt::Debug for AntigravityProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AntigravityProvider")
            .field("instance_id", &self.instance_id)
            .field("settings", &self.settings)
            .finish_non_exhaustive()
    }
}

impl AntigravityProvider {
    /// The instance with its `providerInstances` entry (`None`: the default instance, off).
    pub fn for_instance(
        instance_id: ProviderInstanceId,
        config: AntigravityConfig,
        entry: Option<&Value>,
    ) -> Self {
        let settings = AntigravitySettings::from_instance(entry);
        let dirs = antigravity::directories(&config.state_dir, instance_id.as_str());
        Self {
            instance_id,
            settings,
            config,
            dirs,
            observed: std::sync::Mutex::new(Observed::default()),
        }
    }

    fn self_command(&self) -> String {
        self.config.self_command.clone().unwrap_or_else(|| {
            std::env::current_exe()
                .map(|p| p.display().to_string())
                .unwrap_or_default()
        })
    }

    /// `mergeProviderInstanceEnvironment`: the server's environment with the instance's entries.
    fn base_env(&self) -> Vec<(String, String)> {
        let mut env = conn_support::login_env::child_env();
        for (name, value) in &self.settings.environment {
            env.retain(|(k, _)| k != name);
            env.push((name.clone(), value.clone()));
        }
        env
    }

    async fn resolve(&self) -> Result<PathBuf, String> {
        let binary = self.settings.binary_path.clone();
        let path_var = self
            .base_env()
            .into_iter()
            .find(|(k, _)| k == "PATH")
            .map(|(_, v)| v);
        tokio::task::spawn_blocking(move || {
            antigravity::resolve_executable(&binary, path_var.as_deref())
        })
        .await
        .unwrap_or_else(|_| Err("Could not read the Antigravity installation.".into()))
    }

    /// `onSessionStarted`: the session proves the sign-in; its models and commands are listed.
    fn session_started(&self, initialize: &Value, setup: &Value) {
        let mut observed = lock(&self.observed);
        observed.installed = true;
        observed.authenticated = true;
        observed.status = Some("ready");
        observed.message = None;
        if let Some(version) = initialize["agentInfo"]["version"]
            .as_str()
            .filter(|v| !v.is_empty())
        {
            observed.version = Some(version.to_owned());
        }
        observed.models = antigravity::models_from_session(setup);
    }
}

/// Starts `agy acp` with a fresh temp folder of its own (`run-<random>` under the runtime
/// temp folder); the folder goes when the process has ended.
fn spawner(
    executable: PathBuf,
    dirs: Directories,
    settings: AntigravitySettings,
    base_env: Vec<(String, String)>,
    self_command: String,
    cwd: String,
) -> session::Spawner {
    Arc::new(move || {
        let run_temp = make_run_temp(&dirs.runtime_temp)?;
        let launch = antigravity::launch(
            &executable,
            &dirs,
            &settings,
            &base_env,
            &self_command,
            &run_temp,
        );
        let spec = LaunchSpec {
            program: PathBuf::from(&launch.program),
            args: launch.args.clone(),
            cwd: Some(cwd.clone()),
            env_remove: launch.env_remove,
            env_set: launch.env,
        };
        let (events_tx, events) = mpsc::channel(session::EVENT_CAPACITY);
        let process = match Process::spawn(&spec, MAX_LINE_BYTES, events_tx) {
            Ok(process) => process,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&run_temp);
                return Err(error);
            }
        };
        let writer = process.writer();
        Ok(session::Spawned {
            writer,
            events,
            stop: Box::new(move |kind| {
                Box::pin(async move {
                    stop_process(process, kind).await;
                    // Best effort: the next instance start sweeps nothing, so a folder that
                    // stays (a child still holding it) is left for the OS temp policy.
                    let _ = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(&run_temp))
                        .await;
                })
            }),
        })
    })
}

/// A new `run-XXXXXXXX` folder (0700) below `parent`. Blocking, but small: called from the
/// spawner, which the session runs while it starts an agent.
fn make_run_temp(parent: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(parent)?;
    for _ in 0..16 {
        let id = conn_support::uuid_v4().replace('-', "");
        let dir = parent.join(format!("run-{}", id.get(..12).unwrap_or(&id)));
        match std::fs::create_dir(&dir) {
            Ok(()) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
                }
                return Ok(dir);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::other("no free run folder name"))
}

impl Provider for AntigravityProvider {
    fn instance_id(&self) -> &ProviderInstanceId {
        &self.instance_id
    }

    fn driver(&self) -> &str {
        ANTIGRAVITY.driver
    }

    fn capabilities(&self) -> BoxFuture<'_, ProviderResult<ProviderCapabilities>> {
        Box::pin(async move {
            from_json((ANTIGRAVITY.capabilities)()).map_err(|e| ProviderError::Protocol {
                detail: e.to_string(),
            })
        })
    }

    fn server_provider_entry(&self, checked_at: &str) -> Option<Value> {
        let observed = lock(&self.observed).clone();
        Some(antigravity::entry(
            self.instance_id.as_str(),
            &self.settings,
            &observed,
            checked_at,
        ))
    }

    fn refresh_status(&self, _instance: Option<Value>) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            if !self.settings.enabled {
                return;
            }
            let executable = self.resolve().await;
            let mut observed = lock(&self.observed);
            *observed = antigravity::check(&self.settings, &observed, executable);
        })
    }

    fn open_session(
        &self,
        input: OpenSessionInput,
    ) -> BoxFuture<'_, ProviderResult<OpenedSession>> {
        Box::pin(async move {
            if !self.settings.enabled {
                return Err(ProviderError::Failed {
                    operation: "open_session",
                    detail: "This provider is disabled.".into(),
                });
            }
            if let Some(issue) = self.settings.config_issue() {
                return Err(ProviderError::Failed {
                    operation: "configure",
                    detail: issue.into(),
                });
            }
            let executable = self
                .resolve()
                .await
                .map_err(|detail| ProviderError::Failed {
                    operation: "resolve",
                    detail,
                })?;
            let (dirs, settings) = (self.dirs.clone(), self.settings.clone());
            tokio::task::spawn_blocking(move || antigravity::prepare_profile(&dirs, &settings))
                .await
                .map_err(|_| ProviderError::Failed {
                    operation: "start",
                    detail: "The Antigravity profile directory could not be created.".into(),
                })?
                .map_err(|_| ProviderError::Failed {
                    operation: "start",
                    detail: "The Antigravity profile directory could not be created.".into(),
                })?;
            let cwd = input.runtime_policy.cwd.clone().unwrap_or_else(|| {
                std::env::current_dir()
                    .map(|d| d.display().to_string())
                    .unwrap_or_default()
            });
            let policy = to_json(&input.runtime_policy);
            let selection = to_json(&input.model_selection);
            let self_command = self.self_command();
            let config = session::Config {
                flush_interval: Some(session::FLUSH_INTERVAL),
                finalize_debounce: session::FINALIZE_DEBOUNCE,
                flavor: &ANTIGRAVITY,
                instance_id: self.instance_id.as_str().to_owned(),
                provider_session_id: input.provider_session_id.as_str().to_owned(),
                cwd: cwd.clone(),
                policy: policy.clone(),
                runtime_mode: policy["runtimeMode"]
                    .as_str()
                    .unwrap_or("full-access")
                    .to_owned(),
                effort: None,
                model: selection["model"].as_str().unwrap_or("").to_owned(),
                mcp_servers: input.mcp_servers.clone(),
                client_version: "0.0.0".into(),
                attachments_dir: self.config.attachments_dir.clone(),
                auth_method: Some(self.settings.auth_method.clone()),
                // The `agy` CLI on `PATH` has no version known before `initialize`.
                runtime_version: None,
                self_command: self_command.clone(),
            };
            let (tx, events) = mpsc::channel(session::EVENT_CAPACITY);
            let (session, _) = AcpSession::open(
                config,
                spawner(
                    executable,
                    self.dirs.clone(),
                    self.settings.clone(),
                    self.base_env(),
                    self_command,
                    cwd.clone(),
                ),
                session::system_env(),
                tx,
            )
            .await?;
            let (initialize, setup) = session.handshake().await;
            self.session_started(&initialize, &setup);
            let now = SystemEnv.now();
            let row = json!({
                "id": input.provider_session_id.as_str(),
                "driver": ANTIGRAVITY.driver,
                "providerInstanceId": self.instance_id.as_str(),
                "status": "ready",
                "cwd": cwd,
                "model": selection["model"],
                "capabilities": (ANTIGRAVITY.capabilities)(),
                "createdAt": now,
                "updatedAt": now,
                "lastError": null,
            });
            let provider_session = from_json(row).map_err(|e| ProviderError::Protocol {
                detail: e.to_string(),
            })?;
            Ok(OpenedSession {
                session: Box::new(session),
                events,
                provider_session,
                background_tasks_end_with_process: false,
            })
        })
    }
}
