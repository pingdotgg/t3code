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
    BoxFuture, OpenSessionInput, OpenedSession, Provider, ProviderError, ProviderResult, Session,
};
use conn_provider_support::ids::{Env, SystemEnv};
use conn_provider_support::process::{LaunchSpec, Process};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::antigravity::{self, AntigravitySettings, Directories, Observed};
use crate::session::{self, AcpSession};
use crate::{ANTIGRAVITY, MAX_LINE_BYTES, lock, stop_process};

/// The limit for `agy --version` in a health check.
const VERSION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

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
    /// The model manifest the server accepted last: its default and legacy marks.
    pub model_manifest: conn_provider::LiveManifest,
    /// Tells the server's config streams when a session changed the entry.
    pub status_notifier: conn_provider::StatusNotifier,
}

pub struct AntigravityProvider {
    instance_id: ProviderInstanceId,
    settings: AntigravitySettings,
    config: AntigravityConfig,
    dirs: Directories,
    /// Shared with the sessions' observers, which report what the agent lists.
    observed: Arc<std::sync::Mutex<Observed>>,
    /// Tests start a scripted agent here instead of `agy`.
    #[cfg(test)]
    test_spawner: Option<session::Spawner>,
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
            observed: Arc::default(),
            #[cfg(test)]
            test_spawner: None,
        }
    }

    /// The agent process for a session in `cwd`: `agy acp` from the resolved executable.
    async fn session_spawner(&self, cwd: &str) -> ProviderResult<session::Spawner> {
        #[cfg(test)]
        if let Some(spawner) = &self.test_spawner {
            return Ok(spawner.clone());
        }
        let executable = self
            .resolve()
            .await
            .map_err(|detail| ProviderError::Failed {
                operation: "resolve",
                detail,
            })?;
        Ok(spawner(
            executable,
            self.dirs.clone(),
            self.settings.clone(),
            self.base_env(),
            self.self_command(),
            cwd.to_owned(),
        ))
    }

    /// Changes the entry and tells the config streams.
    fn update(&self, change: impl FnOnce(&Observed) -> Observed) {
        {
            let mut observed = lock(&self.observed);
            *observed = change(&observed);
        }
        self.config.status_notifier.notify();
    }

    /// `onAuthRequired`, published before the failure that caused it is returned.
    fn auth_required(&self) {
        self.update(|observed| antigravity::auth_required(&self.settings, observed));
    }

    /// The session events T3's driver forwards (`onConfigOptionsUpdated`,
    /// `onAvailableCommands`); `cwd` is the session's workspace, `None` for a model refresh.
    fn observer(&self, cwd: Option<String>) -> session::Observer {
        let observed = self.observed.clone();
        let notifier = self.config.status_notifier.clone();
        Arc::new(move |update| {
            {
                let mut current = lock(&observed);
                *current = match update {
                    session::CatalogUpdate::ConfigOptions(options) => {
                        antigravity::config_options_updated(&current, options)
                    }
                    session::CatalogUpdate::AvailableCommands(commands) => {
                        let now = conn_support::time::now_iso();
                        antigravity::available_commands(&current, commands, cwd.as_deref(), &now)
                    }
                };
            }
            notifier.notify();
        })
    }

    /// `publishCatalog`: thinking levels differ per model and the agent reports them only
    /// for the selected one, so each model is selected in turn, then the original again.
    /// Each selection waits for the agent's updates sent before its reply.
    async fn publish_catalog(&self, session: &AcpSession) {
        let (_, setup) = session.handshake().await;
        let options = &setup["configOptions"];
        let current = options.as_array().and_then(|options| {
            options
                .iter()
                .find(|o| o["id"] == "model")
                .and_then(|m| m["currentValue"].as_str())
                .map(str::to_owned)
        });
        let (Some(current), Some(_)) = (current, antigravity::thinking_config(options)) else {
            // No model switch: what the agent already sent still counts.
            session.drain().await;
            return;
        };
        let mut values = antigravity::model_option_values(options);
        values.push(current);
        for value in values {
            // T3 ignores a refused selection; the observer hears the options it applied.
            let _ = session.set_config_option_in_order("model", &value).await;
        }
        session.drain().await;
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

    /// `<agy> --version`, read fresh on every health check: Orbit updates the binary on `PATH`,
    /// so a version kept from an earlier check or session could be stale. It prints the version
    /// and exits (about 0.4 s for 1.5.13); it does not start the agent.
    async fn cli_version(&self, executable: &Path) -> Option<String> {
        let program = executable.to_str()?;
        let output = conn_provider_support::probe::spawn_and_collect(
            program,
            &["--version"],
            &self.base_env(),
            None,
            VERSION_TIMEOUT,
        )
        .await
        .ok()??;
        (output.code == 0)
            .then(|| antigravity::cli_version(&output.stdout))
            .flatten()
    }

    /// `onSessionStarted`: the session proves the sign-in; its models are listed, and its
    /// workspace (`cwd`, none for a model refresh) gets a snapshot.
    fn session_started(&self, initialize: &Value, setup: &Value, cwd: Option<&str>) {
        let now = conn_support::time::now_iso();
        self.update(|observed| {
            antigravity::session_started(
                observed,
                initialize,
                setup,
                cwd.map(|cwd| (cwd, now.as_str())),
            )
        });
    }

    /// Starts `agy acp` and opens a session in `cwd` (T3's `openSession` start); the session
    /// reports the account and models. `control` may end the open; the agent is stopped then.
    #[expect(
        clippy::too_many_arguments,
        reason = "one call per purpose; the fields are the session's own inputs"
    )]
    async fn start(
        &self,
        cwd: String,
        policy: Value,
        model: String,
        provider_session_id: String,
        mcp_servers: Vec<conn_provider::McpServer>,
        purpose: Purpose,
        control: session::OpenControl,
    ) -> ProviderResult<(AcpSession, mpsc::Receiver<conn_provider::ProviderEvent>)> {
        let workspace = purpose == Purpose::Thread;
        if let Some(issue) = self.settings.config_issue() {
            return Err(ProviderError::Failed {
                operation: "configure",
                detail: issue.into(),
            });
        }
        let spawner = self.session_spawner(&cwd).await?;
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
        let self_command = self.self_command();
        let config = session::Config {
            flush_interval: Some(session::FLUSH_INTERVAL),
            finalize_debounce: session::FINALIZE_DEBOUNCE,
            flavor: &ANTIGRAVITY,
            instance_id: self.instance_id.as_str().to_owned(),
            provider_session_id,
            cwd: cwd.clone(),
            runtime_mode: policy["runtimeMode"]
                .as_str()
                .unwrap_or("full-access")
                .to_owned(),
            policy,
            effort: None,
            model,
            mcp_servers,
            client_version: "0.0.0".into(),
            attachments_dir: self.config.attachments_dir.clone(),
            auth_method: Some(self.settings.auth_method.clone()),
            // The `agy` CLI on `PATH` has no version known before `initialize`.
            runtime_version: None,
            self_command,
            // A thread applies the configured default; a model refresh starts, as T3's does,
            // from the model the agent has selected.
            default_model: workspace
                .then(|| antigravity::catalog(&self.config.model_manifest))
                .flatten()
                .and_then(|catalog| catalog.default_model),
            observer: Some(self.observer(workspace.then(|| cwd.clone()))),
        };
        let (tx, events) = mpsc::channel(session::EVENT_CAPACITY);
        let (session, _) =
            AcpSession::open_with(config, spawner, session::system_env(), tx, control)
                .await
                .inspect_err(|error| {
                    if is_sign_in_required(error) {
                        self.auth_required();
                    }
                })?;
        let (initialize, setup) = session.handshake().await;
        self.session_started(&initialize, &setup, workspace.then_some(cwd.as_str()));
        // T3 publishes the session, then its event stream: the metadata the agent sent
        // while it started (its commands) lands on the signed-in entry.
        session.release_catalog_updates().await;
        Ok((session, events))
    }

    /// `refreshModels`: a throwaway session in a scratch folder that publishes the catalog,
    /// closed after. A sign-in failure publishes the signed-out entry first; any other failure
    /// leaves the entry as the last check made it. The error carries the text T3 shows for a
    /// failed explicit refresh.
    async fn load_models(&self) -> ProviderResult<()> {
        let failed = |detail: &str| ProviderError::Failed {
            operation: "refresh-models",
            detail: detail.to_owned(),
        };
        let parent = self.dirs.runtime_temp.join("setup");
        let Ok(Ok(cwd)) = tokio::task::spawn_blocking(move || make_run_temp(&parent)).await else {
            return Err(failed(REFRESH_FAILED));
        };
        let workspace = cwd.display().to_string();
        let policy =
            json!({"runtimeMode": "full-access", "interactionMode": "default", "cwd": workspace});
        let scratch = workspace.clone();
        // T3's scoped refresh: the limit interrupts the work, then the scope stops the agent
        // before the refresh answers.
        let deadline = tokio::time::Instant::now() + MODEL_LOAD_TIMEOUT;
        let loaded = async {
            let control = session::OpenControl {
                abort: Some(Box::pin(tokio::time::sleep_until(deadline))),
            };
            let (session, _events) = self
                .start(
                    workspace,
                    policy,
                    String::new(),
                    format!("antigravity-models-{}", conn_support::uuid_v4()),
                    Vec::new(),
                    Purpose::ModelRefresh,
                    control,
                )
                .await?;
            let session_id = session.handshake().await.1["sessionId"]
                .as_str()
                .map(str::to_owned);
            let published = tokio::time::timeout_at(deadline, self.publish_catalog(&session)).await;
            session.close().await;
            if let Some(session_id) = session_id {
                let profile = self.dirs.profile.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    antigravity::remove_session_files(&profile, &session_id, &scratch);
                })
                .await;
            }
            Ok::<bool, ProviderError>(published.is_ok())
        }
        .await;
        let timed_out = tokio::time::Instant::now() >= deadline;
        let result = match loaded {
            Ok(true) => Ok(()),
            Ok(false) => Err(failed(REFRESH_TIMED_OUT)),
            Err(_) if timed_out => Err(failed(REFRESH_TIMED_OUT)),
            Err(error) => Err(failed(&refresh_failure_detail(&error))),
        };
        let _ = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(&cwd)).await;
        result
    }
}

/// Why a session starts: a thread's workspace gets a snapshot; a model refresh runs in a
/// scratch folder that is no workspace.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Purpose {
    Thread,
    ModelRefresh,
}

/// T3's `refreshModels` limit for the throwaway session.
const MODEL_LOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);
/// `AntigravityDriver.ts` texts for a failed explicit refresh (`tools/check-copies.mjs`).
const REFRESH_FAILED: &str =
    "Could not refresh Antigravity models. The previous model list is unchanged.";
const REFRESH_TIMED_OUT: &str =
    "Antigravity model refresh timed out. Try again or check Google sign-in.";

const REFRESH_SIGN_IN: &str =
    "Sign in to Antigravity in provider settings before refreshing models.";

/// `isAntigravitySignInRequiredError`, as the session reports it (`antigravity::rpc_failure`).
fn is_sign_in_required(error: &ProviderError) -> bool {
    matches!(
        error,
        ProviderError::Failed {
            operation: antigravity::SIGN_IN_REQUIRED,
            ..
        }
    )
}

/// T3's texts: a sign-in instruction, a configuration or start failure's own text, the
/// fixed text with the `python-socks` diagnostic, or the fixed text alone.
fn refresh_failure_detail(error: &ProviderError) -> String {
    match error {
        _ if is_sign_in_required(error) => REFRESH_SIGN_IN.to_owned(),
        ProviderError::Failed {
            operation: "configure" | "start",
            detail,
        } => detail.clone(),
        ProviderError::Failed {
            operation: antigravity::RECEIVE_RESPONSE,
            detail,
        } if detail == antigravity::PYTHON_SOCKS_REQUIRED => format!(
            "{REFRESH_FAILED} Antigravity reported: {}",
            antigravity::PYTHON_SOCKS_REQUIRED
        ),
        _ => REFRESH_FAILED.to_owned(),
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
        // T3's stderr handler: a sign-in URL there ends the session as one on stdout does.
        let process = match Process::spawn_observing_stderr(
            &spec,
            MAX_LINE_BYTES,
            events_tx,
            Some(Box::new(antigravity::stderr_sign_in)),
        ) {
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
            antigravity::catalog(&self.config.model_manifest).as_ref(),
        ))
    }

    fn refresh_status(&self, _instance: Option<Value>) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            if !self.settings.enabled {
                return;
            }
            let executable = self.resolve().await;
            let version = match &executable {
                Ok(path) => self.cli_version(path).await,
                Err(_) => None,
            };
            let load = {
                let mut observed = lock(&self.observed);
                *observed = antigravity::check(&self.settings, &observed, executable, version);
                antigravity::needs_session(&observed)
            };
            // A failure here leaves the entry as the check made it; the next check tries again.
            if load {
                let _ = self.load_models().await;
            }
        })
    }

    fn refresh_models(&self) -> Option<BoxFuture<'_, ProviderResult<()>>> {
        Some(Box::pin(self.load_models()))
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
            let cwd = input.runtime_policy.cwd.clone().unwrap_or_else(|| {
                std::env::current_dir()
                    .map(|d| d.display().to_string())
                    .unwrap_or_default()
            });
            let policy = to_json(&input.runtime_policy);
            let selection = to_json(&input.model_selection);
            let (session, events) = self
                .start(
                    cwd.clone(),
                    policy,
                    selection["model"].as_str().unwrap_or("").to_owned(),
                    input.provider_session_id.as_str().to_owned(),
                    input.mcp_servers.clone(),
                    Purpose::Thread,
                    session::OpenControl::default(),
                )
                .await?;
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

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use super::*;
    use crate::replay_agent::{self, Script};

    fn expect(method: &str, params: Value) -> Value {
        json!({"type": "expect_outbound", "frame": {"kind": "request", "method": method, "params": params}})
    }

    fn reply(method: &str, result: Value) -> Value {
        json!({"type": "emit_inbound", "frame": {"kind": "response", "method": method, "result": result}})
    }

    /// The `model` option on `model` and a thinking option with `levels` (the first current).
    fn options(model: &str, levels: &[&str]) -> Value {
        let levels: Vec<Value> = levels
            .iter()
            .map(|level| json!({"value": level, "name": level}))
            .collect();
        json!([
            {"id": "model", "name": "Model", "category": "model", "type": "select",
             "currentValue": model,
             "options": [{"value": "gemini-a", "name": "Gemini A"},
                         {"value": "gemini-b", "name": "Gemini B"}]},
            {"id": "thought_level", "name": "Thinking", "category": "thought_level",
             "type": "select", "currentValue": levels[0]["value"], "options": levels}
        ])
    }

    /// `initialize` and `authenticate` answered, then `session/new` with `setup_options`.
    fn handshake(setup_options: Value) -> Vec<Value> {
        vec![
            expect("initialize", json!("<any>")),
            reply(
                "initialize",
                json!({"protocolVersion": 1, "agentCapabilities": {},
                       "agentInfo": {"name": "antigravity-acp", "version": "1.5.14"}}),
            ),
            expect("authenticate", json!("<any>")),
            reply("authenticate", json!({})),
            expect("session/new", json!("<any>")),
            reply(
                "session/new",
                json!({"sessionId": "s1", "configOptions": setup_options}),
            ),
        ]
    }

    fn select(model: &str) -> Value {
        expect(
            "session/set_config_option",
            json!({"sessionId": "s1", "configId": "model", "value": model}),
        )
    }

    /// An enabled instance whose agents replay `scripts`, one per start.
    fn provider(
        scripts: Vec<Vec<Value>>,
    ) -> (AntigravityProvider, Vec<Arc<Mutex<Script>>>, PathBuf) {
        let (provider, scripts, dir, _) = provider_with(scripts, Default::default());
        (provider, scripts, dir)
    }

    /// Counts the agent runtimes that ended (their stop dropped or run).
    struct Ended(Arc<std::sync::atomic::AtomicUsize>);

    impl Drop for Ended {
        fn drop(&mut self) {
            self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }

    /// [`provider`] with a live manifest; also returns how many agent runtimes ended.
    fn provider_with(
        scripts: Vec<Vec<Value>>,
        manifest: conn_provider::LiveManifest,
    ) -> (
        AntigravityProvider,
        Vec<Arc<Mutex<Script>>>,
        PathBuf,
        Arc<std::sync::atomic::AtomicUsize>,
    ) {
        let ended = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = ended.clone();
        let dir = std::env::temp_dir().join(format!("conn-agy-{}", conn_support::uuid_v4()));
        let scripts: Vec<_> = scripts
            .into_iter()
            .map(|entries| Script::new(entries, "/w"))
            .collect();
        let queue = Arc::new(Mutex::new(scripts.iter().cloned().collect::<VecDeque<_>>()));
        let mut provider = AntigravityProvider::for_instance(
            "antigravity".into(),
            AntigravityConfig {
                state_dir: dir.clone(),
                attachments_dir: None,
                self_command: Some("/conn-server".into()),
                model_manifest: manifest,
                status_notifier: Default::default(),
            },
            Some(&json!({"enabled": true})),
        );
        provider.test_spawner = Some(Arc::new(move || {
            let script = lock(&queue)
                .pop_front()
                .ok_or_else(|| std::io::Error::other("no script left"))?;
            let (writer, events) = replay_agent::spawn(script);
            let ended = Ended(counter.clone());
            Ok(session::Spawned {
                writer,
                events,
                stop: Box::new(move |_| {
                    drop(ended);
                    Box::pin(async {})
                }),
            })
        }));
        (provider, scripts, dir, ended)
    }

    fn entry_of(provider: &AntigravityProvider) -> Value {
        provider
            .server_provider_entry("2026-11-23T00:00:00.000Z")
            .unwrap()
    }

    fn levels(entry: &Value, slug: &str) -> (Vec<String>, Value) {
        let model = entry["models"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["slug"] == slug)
            .unwrap();
        let descriptor = &model["capabilities"]["optionDescriptors"][0];
        let ids = descriptor["options"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| o["id"].as_str().unwrap().to_owned())
            .collect();
        (ids, descriptor["currentValue"].clone())
    }

    fn complete(script: &Arc<Mutex<Script>>) {
        let script = lock(script);
        assert!(
            script.complete(),
            "stopped at {}: {:?}",
            script.cursor,
            script.failure
        );
    }

    /// T3's `publishCatalog`: each model is selected, then the original again, and the
    /// updates the agent sends before each reply are applied before the session closes. Each
    /// model keeps the thinking levels it reported; here `gemini-b` reports its own through a
    /// `config_option_update` ahead of an empty reply.
    #[tokio::test(flavor = "current_thread")]
    async fn a_model_refresh_lists_each_models_thinking_levels() {
        let a = || options("gemini-a", &["low", "high"]);
        let b = options("gemini-b", &["minimal", "max"]);
        let mut script = handshake(a());
        script.extend([
            select("gemini-a"),
            reply("session/set_config_option", json!({"configOptions": a()})),
            select("gemini-b"),
            json!({"type": "emit_inbound", "frame": {"kind": "notification", "method": "session/update",
                "params": {"sessionId": "s1", "update": {"sessionUpdate": "config_option_update",
                                                          "configOptions": b}}}}),
            reply("session/set_config_option", json!({})),
            select("gemini-a"),
            reply("session/set_config_option", json!({"configOptions": a()})),
        ]);
        let (provider, scripts, dir) = provider(vec![script]);
        provider.refresh_models().unwrap().await.unwrap();
        complete(&scripts[0]);
        let entry = provider
            .server_provider_entry("2026-11-23T00:00:00.000Z")
            .unwrap();
        assert_eq!(entry["auth"]["status"], "authenticated");
        let levels = |slug: &str| {
            let model = entry["models"]
                .as_array()
                .unwrap()
                .iter()
                .find(|m| m["slug"] == slug)
                .unwrap();
            let descriptor = &model["capabilities"]["optionDescriptors"][0];
            let ids: Vec<&str> = descriptor["options"]
                .as_array()
                .unwrap()
                .iter()
                .map(|o| o["id"].as_str().unwrap())
                .collect();
            (
                ids,
                descriptor["currentValue"].clone(),
                model["isDefault"].clone(),
            )
        };
        assert_eq!(
            levels("gemini-a"),
            (vec!["low", "high"], json!("low"), json!(true))
        );
        assert_eq!(
            levels("gemini-b"),
            (vec!["minimal", "max"], json!("minimal"), Value::Null)
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// T3's "closes refresh processes and clears account metadata when Google sign-in is
    /// required": the entry turns unauthenticated without the account's models before the
    /// refresh fails with the sign-in instruction, and health checks stop loading models.
    #[tokio::test(flavor = "current_thread")]
    async fn an_expired_sign_in_publishes_unauthenticated_before_the_failure() {
        let signed_in = handshake(json!([
            {"id": "model", "name": "Model", "category": "model", "type": "select",
             "currentValue": "gemini-a", "options": [{"value": "gemini-a", "name": "Gemini A"}]}
        ]));
        let signed_out = vec![
            expect("initialize", json!("<any>")),
            reply(
                "initialize",
                json!({"protocolVersion": 1, "agentCapabilities": {}}),
            ),
            expect("authenticate", json!("<any>")),
            json!({"type": "emit_inbound", "frame": {"kind": "response", "method": "authenticate",
                "error": {"code": -32000, "message": "Authentication required"}}}),
        ];
        let (provider, scripts, dir) = provider(vec![signed_in, signed_out]);
        provider.refresh_models().unwrap().await.unwrap();
        let checked_at = "2026-11-23T00:00:00.000Z";
        let before = provider.server_provider_entry(checked_at).unwrap();
        assert_eq!(before["auth"]["status"], "authenticated");
        assert_eq!(before["models"].as_array().unwrap().len(), 1);

        let error = provider.refresh_models().unwrap().await.unwrap_err();
        complete(&scripts[1]);
        assert_eq!(
            error,
            ProviderError::Failed {
                operation: "refresh-models",
                detail: REFRESH_SIGN_IN.into(),
            }
        );
        let after = provider.server_provider_entry(checked_at).unwrap();
        assert_eq!(after["auth"], json!({"status": "unauthenticated"}));
        assert_eq!(after["status"], "warning");
        assert_eq!(after["message"], "Sign in with Google to use Antigravity.");
        assert_eq!(after["models"], json!([]));
        assert_eq!(after["slashCommands"], json!([]));
        assert_eq!(after["supportsTextGeneration"], false);
        assert!(!antigravity::needs_session(&lock(&provider.observed)));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// T3's `isAntigravitySignInRequiredError` and `refreshFailureDetail` on error replies.
    #[test]
    fn error_replies_keep_t3s_sign_in_and_python_socks_texts() {
        use crate::protocol::RpcError;
        let classify = |code: i64, message: &str, data: Option<Value>| {
            let error = RpcError {
                code,
                message: message.into(),
                data,
            };
            (ANTIGRAVITY.rpc_failure)(&error).map(|error| refresh_failure_detail(&error))
        };
        assert_eq!(
            classify(-32000, "auth", None).as_deref(),
            Some(REFRESH_SIGN_IN)
        );
        assert_eq!(
            classify(-32603, "No browser is available here to sign in", None).as_deref(),
            Some(REFRESH_SIGN_IN)
        );
        assert_eq!(classify(-32603, "Internal error", None), None);
        let socks =
            json!({"details": "ImportError: python-socks is required to use a SOCKS proxy"});
        assert_eq!(
            classify(-32603, "Internal error", Some(socks)).as_deref(),
            Some(
                "Could not refresh Antigravity models. The previous model list is unchanged. \
                 Antigravity reported: python-socks is required to use a SOCKS proxy"
            )
        );
        assert_eq!(
            refresh_failure_detail(&ProviderError::SessionStopped),
            REFRESH_FAILED
        );
        // "never copies unrecognized agent error details into the refresh error".
        let secret = "https://accounts.example.test/o/oauth2?code=sk-secret-123";
        for data in [
            json!({"details": format!("Token refresh failed for {secret}")}),
            json!({"details": {"stack": "secret frame", "env": {"HOME": "/"}}}),
            json!(["python-socks is required to use a SOCKS proxy"]),
        ] {
            let error = RpcError {
                code: -32603,
                message: format!("Internal error {secret}"),
                data: Some(data.clone()),
            };
            assert_eq!((ANTIGRAVITY.rpc_failure)(&error), None, "{data}");
            let generic = ProviderError::Failed {
                operation: "session/new",
                detail: error.message.clone(),
            };
            assert_eq!(refresh_failure_detail(&generic), REFRESH_FAILED, "{data}");
        }
        let known = RpcError {
            code: -32603,
            message: "Internal error".into(),
            data: Some(json!({"details": format!(
                "Traceback (most recent call last):\n  proxy {secret}\npython-socks is required to use a SOCKS proxy"
            )})),
        };
        let detail = (ANTIGRAVITY.rpc_failure)(&known).map(|e| refresh_failure_detail(&e));
        assert!(detail.as_deref().is_some_and(|d| !d.contains("sk-secret")));
    }

    /// T3's `classifyModels` with `ModelCatalog.current`: a fetched manifest's default and
    /// legacy marks reach the entry, and a session that asks for the default gets it.
    #[tokio::test(flavor = "current_thread")]
    async fn a_fetched_manifest_reaches_the_antigravity_entry() {
        let live = conn_provider::LiveManifest::default();
        let setup = json!([{"id": "model", "name": "Model", "category": "model", "type": "select",
            "currentValue": "gemini-a",
            "options": [{"value": "gemini-a", "name": "Gemini A"}, {"value": "gemini-b", "name": "Gemini B"},
                        {"value": "gemini-old", "name": "Gemini Old"}]}]);
        let (provider, _scripts, dir, _) = provider_with(vec![handshake(setup)], live.clone());
        provider.refresh_models().unwrap().await.unwrap();
        let default = |entry: &Value| {
            entry["models"]
                .as_array()
                .unwrap()
                .iter()
                .find(|m| m["isDefault"] == true)
                .map(|m| m["slug"].clone())
        };
        assert_eq!(default(&entry_of(&provider)), Some(json!("gemini-a")));
        live.set(json!({"providers": {"antigravity": {
            "profiles": {},
            "defaults": {"chat": "gemini-b"},
            "models": [{"slug": "gemini-b", "name": "B", "status": "current"},
                       {"slug": "gemini-old", "name": "Old", "status": "legacy"}]
        }}}));
        let entry = entry_of(&provider);
        assert_eq!(default(&entry), Some(json!("gemini-b")));
        let old = entry["models"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["slug"] == "gemini-old")
            .unwrap();
        assert_eq!(old["isLegacy"], true);
        let catalog = antigravity::catalog(&live).unwrap();
        assert_eq!(catalog.default_model.as_deref(), Some("gemini-b"));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// T3's `configOptionUpdates` check: an update the agent pushed while a selection was in
    /// flight is newer than the selection's reply, which stays out.
    #[tokio::test(flavor = "current_thread")]
    async fn an_update_during_a_selection_beats_its_stale_reply() {
        let a = || options("gemini-a", &["low", "high"]);
        let b = options("gemini-b", &["minimal", "max"]);
        let stale = options("gemini-b", &["low", "high"]);
        let mut script = handshake(a());
        script.extend([
            select("gemini-a"),
            reply("session/set_config_option", json!({"configOptions": a()})),
            select("gemini-b"),
            json!({"type": "emit_inbound", "frame": {"kind": "notification", "method": "session/update",
                "params": {"sessionId": "s1", "update": {"sessionUpdate": "config_option_update",
                                                          "configOptions": b}}}}),
            reply("session/set_config_option", json!({"configOptions": stale})),
            select("gemini-a"),
            reply("session/set_config_option", json!({"configOptions": a()})),
        ]);
        let (provider, scripts, dir) = provider(vec![script]);
        provider.refresh_models().unwrap().await.unwrap();
        complete(&scripts[0]);
        let entry = entry_of(&provider);
        assert_eq!(
            levels(&entry, "gemini-b"),
            (
                vec!["minimal".to_owned(), "max".to_owned()],
                json!("minimal")
            )
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// T3 consumes `AvailableCommandsUpdated` and drains the events before it closes the
    /// session, also when no model switch runs.
    #[tokio::test(flavor = "current_thread")]
    async fn a_refresh_without_a_model_switch_keeps_the_agents_commands() {
        let mut script = handshake(json!([{"id": "model", "name": "Model", "category": "model",
            "type": "select", "currentValue": "gemini-a",
            "options": [{"value": "gemini-a", "name": "Gemini A"}]}]));
        script.push(json!({"type": "emit_inbound", "frame": {"kind": "notification", "method": "session/update",
            "params": {"sessionId": "s1", "update": {"sessionUpdate": "available_commands_update",
                "availableCommands": [{"name": "goal", "description": " Set a goal ",
                                        "input": {"hint": "Objective"}},
                                       {"name": "goal", "description": "again"}]}}}}));
        let (provider, scripts, dir) = provider(vec![script]);
        provider.refresh_models().unwrap().await.unwrap();
        complete(&scripts[0]);
        assert_eq!(
            entry_of(&provider)["slashCommands"],
            json!([{"name": "goal", "description": "Set a goal", "input": {"hint": "Objective"}}])
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// T3's expired-sign-in fixture: `agy` prints a plain-text sign-in URL. The refresh stops
    /// the agent, and a client already subscribed sees the unauthenticated entry before the
    /// sign-in error returns.
    #[tokio::test(flavor = "current_thread")]
    async fn a_sign_in_url_ends_the_refresh_and_signs_out() {
        let url = "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F&state=fixture-state";
        let signed_in = handshake(json!([{"id": "model", "name": "Model", "category": "model",
            "type": "select", "currentValue": "gemini-a",
            "options": [{"value": "gemini-a", "name": "Gemini A"}]}]));
        let login = vec![
            expect("initialize", json!("<any>")),
            json!({"type": "emit_raw", "line": format!("{}{url}", antigravity::AUTH_STDOUT_PREFIX)}),
        ];
        let (provider, scripts, dir, ended) =
            provider_with(vec![signed_in, login], Default::default());
        provider.refresh_models().unwrap().await.unwrap();
        assert_eq!(entry_of(&provider)["auth"]["status"], "authenticated");
        let mut changes = provider.config.status_notifier.subscribe();
        changes.mark_unchanged();
        let error = provider.refresh_models().unwrap().await.unwrap_err();
        assert_eq!(
            error,
            ProviderError::Failed {
                operation: "refresh-models",
                detail: REFRESH_SIGN_IN.into(),
            }
        );
        assert!(
            changes.has_changed().unwrap(),
            "the config stream heard the sign-out"
        );
        let entry = entry_of(&provider);
        assert_eq!(entry["auth"], json!({"status": "unauthenticated"}));
        assert_eq!(entry["models"], json!([]));
        assert_eq!(
            ended.load(std::sync::atomic::Ordering::Relaxed),
            2,
            "both agents ended"
        );
        assert_eq!(
            lock(&scripts[1]).cursor,
            2,
            "the agent got no request after the URL"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// `parseAntigravityAuthorizationUrl` and T3's stdout and stderr signals.
    #[test]
    fn sign_in_urls_are_recognised_as_t3_recognises_them() {
        let url = "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F&state=fixture-state";
        assert!(antigravity::is_authorization_url(url));
        for bad in [
            "https://evil.example/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F&state=s",
            "https://accounts.google.com/o/oauth2/v2/auth?response_type=token&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F&state=s",
            "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A80%2F&state=s",
            "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F",
            "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F&state=a&state=b",
        ] {
            assert!(!antigravity::is_authorization_url(bad), "{bad}");
        }
        let prefix = antigravity::AUTH_STDOUT_PREFIX;
        assert_eq!(
            antigravity::stdout_signal(&format!("{prefix}{url}")),
            Some(ProviderError::Failed {
                operation: antigravity::SIGN_IN_REQUIRED,
                detail: antigravity::SIGN_IN_REQUIRED_MESSAGE.into(),
            })
        );
        assert!(matches!(
            antigravity::stdout_signal(&format!("{prefix}https://example.com")),
            Some(ProviderError::Failed {
                operation: "authorization-url",
                ..
            })
        ));
        assert_eq!(antigravity::stdout_signal("{\"jsonrpc\":\"2.0\"}"), None);
        let carried = Some(format!("{prefix}{url}"));
        assert_eq!(
            antigravity::stderr_sign_in(&format!("{prefix}{url}\r")),
            carried
        );
        let marker = format!("{}{}", antigravity::AUTH_BROWSER_MARKER, json!(url));
        assert_eq!(antigravity::stderr_sign_in(&marker), carried);
        assert_eq!(
            antigravity::stderr_sign_in(&format!("{prefix}https://example.com")),
            None
        );
        assert_eq!(antigravity::stderr_sign_in("I1123 log line"), None);
    }

    /// The stops a test spawner ran, in order.
    type Stops = Arc<Mutex<Vec<session::StopKind>>>;

    /// Replaces the provider's agents with `scripts`; returns the stops that ran (not only
    /// dropped), in order: a run stop is what removes the `run-*` folder and ends the process
    /// tree.
    fn count_stops(
        provider: &mut AntigravityProvider,
        scripts: Vec<Vec<Value>>,
    ) -> (Vec<Arc<Mutex<Script>>>, Stops) {
        let stops = Arc::new(Mutex::new(Vec::new()));
        let scripts: Vec<_> = scripts
            .into_iter()
            .map(|entries| Script::new(entries, "/w"))
            .collect();
        let queue = Arc::new(Mutex::new(scripts.iter().cloned().collect::<VecDeque<_>>()));
        let counter = stops.clone();
        provider.test_spawner = Some(Arc::new(move || {
            let script = lock(&queue)
                .pop_front()
                .ok_or_else(|| std::io::Error::other("no script left"))?;
            let (writer, events) = replay_agent::spawn(script);
            let counter = counter.clone();
            Ok(session::Spawned {
                writer,
                events,
                stop: Box::new(move |kind| {
                    lock(&counter).push(kind);
                    Box::pin(async {})
                }),
            })
        }));
        (scripts, stops)
    }

    /// A handshake that fails while the agent still runs, and one whose agent exits, end the
    /// agent as a close does: its stop runs once.
    #[tokio::test(flavor = "current_thread")]
    async fn a_failed_handshake_stops_the_agent() {
        let refused = vec![
            expect("initialize", json!("<any>")),
            json!({"type": "emit_inbound", "frame": {"kind": "response", "method": "initialize",
                "error": {"code": -32603, "message": "boom"}}}),
        ];
        let exits = vec![
            expect("initialize", json!("<any>")),
            json!({"type": "runtime_exit", "status": "failure"}),
        ];
        let (mut provider, _, dir, _) = provider_with(Vec::new(), Default::default());
        let (_scripts, stops) = count_stops(&mut provider, vec![refused, exits]);
        assert!(provider.refresh_models().unwrap().await.is_err());
        assert_eq!(lock(&stops).len(), 1);
        assert!(provider.refresh_models().unwrap().await.is_err());
        for _ in 0..16 {
            tokio::task::yield_now().await;
        }
        assert_eq!(lock(&stops).len(), 2);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// An agent that exits on its own has been reaped by the time the session hears it: the
    /// session removes its files but signals neither its PID nor its group, which the OS may
    /// already have given to another process.
    #[tokio::test(flavor = "current_thread")]
    async fn an_agent_that_exited_is_cleaned_up_without_a_signal() {
        let mut script = handshake(json!([]));
        script.extend([
            json!({"type": "runtime_exit", "status": "success"}),
            expect("never", json!("<any>")),
        ]);
        let (mut provider, _, dir, _) = provider_with(Vec::new(), Default::default());
        let (_scripts, stops) = count_stops(&mut provider, vec![script]);
        let (session, _events) = provider
            .start(
                "/w".into(),
                json!({"runtimeMode": "full-access", "cwd": "/w"}),
                String::new(),
                "exits".into(),
                Vec::new(),
                Purpose::ModelRefresh,
                session::OpenControl::default(),
            )
            .await
            .unwrap();
        for _ in 0..64 {
            if !lock(&stops).is_empty() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(*lock(&stops), [session::StopKind::Exited]);
        drop(session);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// T3's refresh is scoped: its 90 s limit interrupts an agent that never answers
    /// `initialize`, and the scope stops that agent before the refresh answers.
    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn a_refresh_that_times_out_in_initialize_stops_the_agent() {
        let silent = vec![
            expect("initialize", json!("<any>")),
            expect("never", json!("<any>")),
        ];
        let (mut provider, _, dir, _) = provider_with(Vec::new(), Default::default());
        let (_scripts, stops) = count_stops(&mut provider, vec![silent]);
        let error = provider.refresh_models().unwrap().await.unwrap_err();
        assert_eq!(
            error,
            ProviderError::Failed {
                operation: "refresh-models",
                detail: REFRESH_TIMED_OUT.into(),
            }
        );
        assert_eq!(*lock(&stops), [session::StopKind::Kill]);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// After a sign-in failure clears the account's metadata, the retry's commands, sent
    /// while the agent starts, land on the signed-in entry: T3 publishes the session before
    /// it delivers the session's events.
    #[tokio::test(flavor = "current_thread")]
    async fn a_retry_after_a_sign_in_failure_keeps_the_agents_commands() {
        let url = "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F&state=fixture-state";
        let login = vec![
            expect("initialize", json!("<any>")),
            json!({"type": "emit_raw", "line": format!("{}{url}", antigravity::AUTH_STDOUT_PREFIX)}),
        ];
        let mut retry = handshake(json!([{"id": "model", "name": "Model", "category": "model",
            "type": "select", "currentValue": "gemini-a",
            "options": [{"value": "gemini-a", "name": "Gemini A"}]}]));
        let reply_at = retry.len() - 1;
        retry.insert(
            reply_at,
            json!({"type": "emit_inbound", "frame": {"kind": "notification", "method": "session/update",
                "params": {"sessionId": "s1", "update": {"sessionUpdate": "available_commands_update",
                    "availableCommands": [{"name": "goal", "description": "Set a goal"}]}}}}),
        );
        let (provider, scripts, dir) = provider(vec![login, retry]);
        assert!(provider.refresh_models().unwrap().await.is_err());
        assert_eq!(
            entry_of(&provider)["auth"],
            json!({"status": "unauthenticated"})
        );
        provider.refresh_models().unwrap().await.unwrap();
        complete(&scripts[1]);
        assert_eq!(
            entry_of(&provider)["slashCommands"],
            json!([{"name": "goal", "description": "Set a goal"}])
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// `agy` can print the sign-in URL right behind its `initialize` reply. The connection
    /// keeps that failure: the next call fails with it, so the refresh signs out.
    #[tokio::test(flavor = "current_thread")]
    async fn a_sign_in_url_behind_the_initialize_reply_signs_out() {
        let url = "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F&state=fixture-state";
        let login = vec![
            expect("initialize", json!("<any>")),
            reply(
                "initialize",
                json!({"protocolVersion": 1, "agentCapabilities": {}}),
            ),
            json!({"type": "emit_raw", "line": format!("{}{url}", antigravity::AUTH_STDOUT_PREFIX)}),
        ];
        let (mut provider, _, dir, _) = provider_with(Vec::new(), Default::default());
        let (scripts, stops) = count_stops(&mut provider, vec![login]);
        let error = provider.refresh_models().unwrap().await.unwrap_err();
        assert_eq!(
            error,
            ProviderError::Failed {
                operation: "refresh-models",
                detail: REFRESH_SIGN_IN.into(),
            }
        );
        assert_eq!(
            entry_of(&provider)["auth"],
            json!({"status": "unauthenticated"})
        );
        assert_eq!(lock(&scripts[0]).cursor, 3, "no request after the URL");
        assert_eq!(lock(&stops).len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A model refresh opens a throwaway native session in its scratch folder. After the
    /// close its files leave the profile (`removeAntigravitySessionFiles`): only a v4 UUID
    /// whose metadata names that folder; another session's files stay.
    #[tokio::test(flavor = "current_thread")]
    async fn a_model_refresh_removes_its_native_session_files() {
        let ours = "00000000-0000-4000-8000-00000000a6f1";
        let theirs = "00000000-0000-4000-8000-0000000000b2";
        let mut script = handshake(json!([{"id": "model", "name": "Model", "category": "model",
            "type": "select", "currentValue": "gemini-a",
            "options": [{"value": "gemini-a", "name": "Gemini A"}]}]));
        let last = script.len() - 1;
        script[last]["frame"]["result"]["sessionId"] = json!(ours);
        let (mut provider, _, dir, _) = provider_with(Vec::new(), Default::default());
        let queue = Arc::new(Mutex::new(Some(Script::new(script, "/w"))));
        let acp = provider.dirs.profile.join("antigravity-acp");
        let setup = provider.dirs.runtime_temp.join("setup");
        let (conversations, brain) = (acp.join("conversations"), acp.join("brain"));
        let planted = (conversations.clone(), brain.clone());
        provider.test_spawner = Some(Arc::new(move || {
            // The scratch folder exists now: the agent records its session there.
            let scratch = std::fs::read_dir(&setup)?.next().unwrap()?.path();
            let (conversations, brain) = &planted;
            std::fs::create_dir_all(conversations)?;
            for (id, cwd) in [
                (ours, scratch.display().to_string()),
                (theirs, "/elsewhere".into()),
            ] {
                std::fs::write(
                    conversations.join(format!("{id}.meta")),
                    json!({"cwd": cwd}).to_string(),
                )?;
                std::fs::write(conversations.join(format!("{id}.db")), "")?;
                std::fs::create_dir_all(brain.join(id))?;
            }
            let script = lock(&queue)
                .take()
                .ok_or_else(|| std::io::Error::other("no script"))?;
            let (writer, events) = replay_agent::spawn(script);
            Ok(session::Spawned {
                writer,
                events,
                stop: Box::new(|_| Box::pin(async {})),
            })
        }));
        provider.refresh_models().unwrap().await.unwrap();
        for suffix in [".meta", ".db"] {
            assert!(
                !conversations.join(format!("{ours}{suffix}")).exists(),
                "{suffix}"
            );
            assert!(
                conversations.join(format!("{theirs}{suffix}")).exists(),
                "{suffix}"
            );
        }
        assert!(!brain.join(ours).exists());
        assert!(brain.join(theirs).exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// T3's start checks the recorded termination when it commits: a sign-in URL right
    /// behind the final `session/new` reply fails the open, signs out, and releases none of
    /// the commands held since the start.
    #[tokio::test(flavor = "current_thread")]
    async fn a_sign_in_url_behind_the_session_new_reply_signs_out() {
        let url = "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F&state=fixture-state";
        let script = vec![
            expect("initialize", json!("<any>")),
            reply(
                "initialize",
                json!({"protocolVersion": 1, "agentCapabilities": {}}),
            ),
            expect("authenticate", json!("<any>")),
            reply("authenticate", json!({})),
            expect("session/new", json!("<any>")),
            json!({"type": "emit_inbound", "frame": {"kind": "notification",
                "method": "session/update", "params": {"sessionId": "s1", "update": {
                    "sessionUpdate": "available_commands_update",
                    "availableCommands": [{"name": "root-cmd", "description": "Root"}]}}}}),
            reply(
                "session/new",
                json!({"sessionId": "s1", "configOptions": []}),
            ),
            json!({"type": "emit_raw", "line": format!("{}{url}", antigravity::AUTH_STDOUT_PREFIX)}),
        ];
        let (provider, _, dir) = provider(vec![script]);
        let error = provider.refresh_models().unwrap().await.unwrap_err();
        assert_eq!(
            error,
            ProviderError::Failed {
                operation: "refresh-models",
                detail: REFRESH_SIGN_IN.into(),
            }
        );
        let entry = entry_of(&provider);
        assert_eq!(entry["auth"], json!({"status": "unauthenticated"}));
        assert!(
            !entry["slashCommands"]
                .as_array()
                .is_some_and(|c| c.iter().any(|c| c["name"] == "root-cmd")),
            "{entry}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// T3's `refreshModels` starts its throwaway session as the agent opens it: the catalog
    /// starts from the agent's own model. The manifest's default is for a thread.
    #[tokio::test(flavor = "current_thread")]
    async fn a_model_refresh_starts_from_the_agents_current_model() {
        let live = conn_provider::LiveManifest::default();
        live.set(json!({"providers": {"antigravity": {
            "profiles": {},
            "defaults": {"chat": "gemini-b"},
            "models": [{"slug": "gemini-a", "name": "A", "status": "current"},
                       {"slug": "gemini-b", "name": "B", "status": "current"}]
        }}}));
        let a = || options("gemini-a", &["low", "high"]);
        let b = options("gemini-b", &["minimal", "max"]);
        let mut script = handshake(a());
        script.extend([
            select("gemini-a"),
            reply("session/set_config_option", json!({"configOptions": a()})),
            select("gemini-b"),
            reply("session/set_config_option", json!({"configOptions": b})),
            select("gemini-a"),
            reply("session/set_config_option", json!({"configOptions": a()})),
        ]);
        let (provider, scripts, dir, _) = provider_with(vec![script], live);
        provider.refresh_models().unwrap().await.unwrap();
        complete(&scripts[0]);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// T3's runtime publishes one root session: another session's commands and options stay
    /// out, and the root's commands sent before `session/new` answered still count.
    #[tokio::test(flavor = "current_thread")]
    async fn only_the_root_sessions_metadata_reaches_the_entry() {
        let update = |session: &str, update: Value| {
            json!({"type": "emit_inbound", "frame": {"kind": "notification",
                "method": "session/update", "params": {"sessionId": session, "update": update}}})
        };
        let commands = |name: &str| {
            json!({"sessionUpdate": "available_commands_update",
                "availableCommands": [{"name": name, "description": name}]})
        };
        let model = |id: &str| {
            json!([{"id": "model", "name": "Model", "category": "model", "type": "select",
                "currentValue": id, "options": [{"value": id, "name": id}]}])
        };
        let script = vec![
            expect("initialize", json!("<any>")),
            reply(
                "initialize",
                json!({"protocolVersion": 1, "agentCapabilities": {}}),
            ),
            expect("authenticate", json!("<any>")),
            reply("authenticate", json!({})),
            expect("session/new", json!("<any>")),
            update("s1", commands("root-cmd")),
            update("child", commands("child-early")),
            reply(
                "session/new",
                json!({"sessionId": "s1", "configOptions": model("gemini-a")}),
            ),
            update(
                "child",
                json!({"sessionUpdate": "config_option_update", "configOptions": model("gemini-z")}),
            ),
            update("child", commands("child-late")),
        ];
        let (provider, scripts, dir) = provider(vec![script]);
        provider.refresh_models().unwrap().await.unwrap();
        complete(&scripts[0]);
        let entry = entry_of(&provider);
        let names = |list: &Value, key: &str| -> Vec<String> {
            list.as_array()
                .unwrap()
                .iter()
                .map(|v| v[key].as_str().unwrap().to_owned())
                .collect()
        };
        let commands = names(&entry["slashCommands"], "name");
        assert!(commands.contains(&"root-cmd".to_owned()), "{commands:?}");
        assert!(
            !commands.iter().any(|c| c.starts_with("child")),
            "{commands:?}"
        );
        let models = names(&entry["models"], "slug");
        assert!(models.contains(&"gemini-a".to_owned()), "{models:?}");
        assert!(!models.contains(&"gemini-z".to_owned()), "{models:?}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
