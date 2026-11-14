//! The ACP provider for Conn Server: agents that speak the Agent Client Protocol on stdio
//! (Grok first; Kiro, fx, Antigravity and the ACP registry follow the same runtime).
//!
//! - [`protocol`], [`ordered`]: JSON-RPC frames, written with T3's key order.
//! - [`connection`]: request ids and replies on one agent's stdio.
//! - [`mapper`], [`tools`], [`diff`]: agent frames → `ProviderEvent`s (pure, replay-tested).
//! - [`session`]: the `Session`: process, handshake, prompts, Stop, close.
//! - [`flavor`]: what differs per agent.
//!
//! Reference behaviour: `packages/provider-acp` and `packages/provider-grok` in the Conn
//! monorepo. See `README.md` for what is ported, what is not, and the proofs.

mod connection;
mod diff;
pub mod flavor;
mod grok;
mod grok_background;
mod grok_status;
#[rustfmt::skip]
mod instructions;
mod mapper;
mod ordered;
mod policy;
mod probe;
mod prompt;
mod protocol;
mod session;
mod tools;

#[cfg(test)]
mod replay_agent;
#[cfg(test)]
mod replay_tests;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use conn_contract::{ProviderCapabilities, ProviderInstanceId, from_json, to_json};
use conn_provider::{
    BoxFuture, OpenSessionInput, OpenedSession, Provider, ProviderError, ProviderResult,
};
use conn_provider_support::ids::{Env, SystemEnv};
use conn_provider_support::process::{LaunchSpec, Process};
use serde_json::json;
use tokio::sync::mpsc;

pub use flavor::{Flavor, GROK, Launch};
pub use session::AcpSession;

/// Locks a std mutex. A poisoned lock means a thread panicked while it held the lock: a bug.
pub(crate) fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().expect("conn-provider-acp lock poisoned")
}

/// One agent line may be this long; longer lines are dropped and logged.
const MAX_LINE_BYTES: usize = 64 * 1024 * 1024;
/// `processGroupTerminationGrace`: SIGTERM to SIGKILL on Stop.
const TERMINATE_GRACE: Duration = Duration::from_secs(1);

/// Ends an agent as T3 ends one it owns in a detached process group.
async fn stop_process(process: Process, kind: session::StopKind) {
    #[cfg(unix)]
    {
        use conn_provider_support::process::signal_group;
        use rustix::process::Signal;
        match kind {
            session::StopKind::Kill => signal_group(process.pid, Signal::KILL),
            session::StopKind::Terminate => {
                signal_group(process.pid, Signal::TERM);
                let pid = process.pid;
                if !conn_provider_support::process::wait_gone(pid, TERMINATE_GRACE).await {
                    signal_group(pid, Signal::KILL);
                }
            }
        }
    }
    #[cfg(not(unix))]
    let _ = kind;
    // The child is gone or going; reap it.
    process.shutdown().await;
}

/// The ACP `initialize` probe (`discoverGrokMetadataViaAcpInitialize`): starts
/// `<binary> agent stdio` in `cwd` with the probe environment, sends `initialize` as client
/// `t3-code-provider-probe`, and ends the agent as the runtime's scope does (SIGKILL to its
/// process group). `None` when the agent cannot start, fails or misses the timeout.
pub(crate) async fn initialize_probe(
    binary: &str,
    environment: &[(String, String)],
    cwd: &std::path::Path,
    timeout: Duration,
) -> Option<serde_json::Value> {
    let launch = (GROK.launch)(binary, None, environment);
    let spawned = process_spawner(launch, cwd.display().to_string())().ok()?;
    let (connection, mut incoming) =
        connection::Connection::start(spawned.writer, spawned.events, session::EVENT_CAPACITY);
    // Nothing is served during the probe; agent frames are read and dropped.
    let drain = tokio::spawn(async move { while incoming.recv().await.is_some() {} });
    let params = session::initialize_params(&GROK, "t3-code-provider-probe", "0.0.0", false);
    let result = tokio::time::timeout(timeout, connection.call("initialize", params)).await;
    (spawned.stop)(session::StopKind::Kill).await;
    drain.abort();
    match result {
        Ok(Ok(value)) => Some(value),
        _ => None,
    }
}

/// One configured ACP agent instance.
#[derive(Clone, Debug)]
pub struct AcpConfig {
    /// The executable: the user's setting, or the flavor's default name on `PATH`.
    pub binary: String,
    /// The instance's own environment entries, added to the inherited environment.
    pub environment: Vec<(String, String)>,
    /// The server's working folder (`process.cwd()`), where status probes run.
    pub server_cwd: PathBuf,
    /// The server's workspace (`host.paths.cwd`), where `grok inspect` looks for skills.
    pub workspace_cwd: Option<PathBuf>,
    /// `ACP_TEXT_FLUSH_INTERVAL` (50 ms): streamed text that changed after its first emission
    /// goes out this long later. `None` holds it until its segment closes, as T3's paused test
    /// clock does; only replays of T3's fixtures set that.
    pub text_flush_interval: Option<Duration>,
    /// `ACP_DEFERRED_FINALIZE_DEBOUNCE` (3 s): a turn whose background work ended finalizes
    /// this long after the last change. Replays of T3's fixtures shorten it, as T3's test
    /// clock skips it.
    pub finalize_debounce: Duration,
}

impl Default for AcpConfig {
    fn default() -> Self {
        Self {
            binary: String::new(),
            environment: Vec::new(),
            server_cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")),
            workspace_cwd: None,
            text_flush_interval: Some(session::FLUSH_INTERVAL),
            finalize_debounce: session::FINALIZE_DEBOUNCE,
        }
    }
}

pub use grok_status::GrokSettings;

/// The instance's settings and its last `ServerProvider` entry.
struct Status {
    settings: GrokSettings,
    entry: serde_json::Value,
}

pub struct AcpProvider {
    instance_id: ProviderInstanceId,
    flavor: &'static Flavor,
    config: AcpConfig,
    status: std::sync::Mutex<Status>,
    /// One probe at a time (`refreshSemaphore`).
    probing: tokio::sync::Mutex<()>,
}

impl std::fmt::Debug for AcpProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AcpProvider")
            .field("instance_id", &self.instance_id)
            .field("driver", &self.flavor.driver)
            .finish_non_exhaustive()
    }
}

impl AcpProvider {
    /// An enabled provider for the given binary and environment (examples and tests). Until
    /// the first [`Provider::refresh_status`] its entry is T3's initial snapshot.
    pub fn new(
        instance_id: ProviderInstanceId,
        flavor: &'static Flavor,
        config: AcpConfig,
    ) -> Self {
        let settings = GrokSettings {
            binary_path: if config.binary.trim().is_empty() {
                flavor.driver.to_owned()
            } else {
                config.binary.trim().to_owned()
            },
            environment: config.environment.clone(),
            enabled: true,
            ..GrokSettings::default()
        };
        Self::with_settings(instance_id, flavor, config, settings)
    }

    /// A provider with explicit settings (the server reads them from `providerInstances`).
    pub fn with_settings(
        instance_id: ProviderInstanceId,
        flavor: &'static Flavor,
        config: AcpConfig,
        settings: GrokSettings,
    ) -> Self {
        let entry = grok_status::initial_entry(
            instance_id.as_str(),
            &settings,
            &conn_support::time::iso_from_ms(conn_support::time::now_ms()),
        );
        Self {
            instance_id,
            flavor,
            config,
            status: std::sync::Mutex::new(Status { settings, entry }),
            probing: tokio::sync::Mutex::new(()),
        }
    }

    fn settings(&self) -> GrokSettings {
        lock(&self.status).settings.clone()
    }

    /// The launch for a runtime mode (Grok: `grokLaunchRuntimeMode` of the policy), from the
    /// instance's current settings.
    pub fn launch(&self, runtime_mode: Option<&str>) -> Launch {
        let settings = self.settings();
        (self.flavor.launch)(&settings.binary_path, runtime_mode, &settings.environment)
    }

    /// `checkGrokProviderStatus` with the given settings, and the result kept as the entry.
    async fn probe(&self, settings: GrokSettings) {
        let _one = self.probing.lock().await;
        {
            // New settings take effect at once; until the probe ends the entry is T3's
            // initial snapshot for them.
            let mut status = lock(&self.status);
            if status.settings != settings {
                status.entry = grok_status::initial_entry(
                    self.instance_id.as_str(),
                    &settings,
                    &conn_support::time::iso_from_ms(conn_support::time::now_ms()),
                );
                status.settings = settings.clone();
            }
        }
        // The login shell's PATH reaches the probe as T3's `process.env` does.
        let base = conn_support::login_env::child_env();
        let context = grok_status::ProbeContext {
            base_env: &base,
            server_cwd: &self.config.server_cwd,
            workspace_cwd: self.config.workspace_cwd.clone(),
        };
        let checked_at = conn_support::time::iso_from_ms(conn_support::time::now_ms());
        let entry =
            grok_status::check_status(self.instance_id.as_str(), &settings, &context, &checked_at)
                .await;
        let mut status = lock(&self.status);
        status.settings = settings;
        status.entry = entry;
    }
}

#[doc(hidden)]
pub mod status_testing {
    //! For `examples/grok_probe`: T3's `checkGrokProviderStatus` inputs as ours.
    use std::path::Path;

    pub use crate::grok_status::GrokSettings;

    /// Runs the probe with an explicit base environment and folders.
    pub async fn check(
        instance_id: &str,
        settings: &GrokSettings,
        base_env: &[(String, String)],
        server_cwd: &Path,
        workspace_cwd: Option<&Path>,
        checked_at: &str,
    ) -> serde_json::Value {
        let context = crate::grok_status::ProbeContext {
            base_env,
            server_cwd,
            workspace_cwd: workspace_cwd.map(Path::to_path_buf),
        };
        crate::grok_status::check_status(instance_id, settings, &context, checked_at).await
    }
}

/// `grokLaunchRuntimeMode`: an explicit approval or sandbox policy launches in ask mode.
fn launch_runtime_mode(input: &OpenSessionInput) -> String {
    let policy = to_json(&input.runtime_policy);
    if input.runtime_policy.approval_policy.is_some()
        || input.runtime_policy.sandbox_policy.is_some()
    {
        "approval-required".into()
    } else {
        policy["runtimeMode"]
            .as_str()
            .unwrap_or("full-access")
            .to_owned()
    }
}

fn process_spawner(launch: Launch, cwd: String) -> session::Spawner {
    Arc::new(move || {
        let spec = LaunchSpec {
            program: PathBuf::from(&launch.program),
            args: launch.args.clone(),
            cwd: Some(cwd.clone()),
            env_remove: Vec::new(),
            env_set: launch.env.clone(),
        };
        let (events_tx, events) = mpsc::channel(session::EVENT_CAPACITY);
        let process = Process::spawn(&spec, MAX_LINE_BYTES, events_tx)?;
        let writer = process.writer();
        Ok(session::Spawned {
            writer,
            events,
            stop: Box::new(move |kind| Box::pin(stop_process(process, kind))),
        })
    })
}

impl Provider for AcpProvider {
    fn instance_id(&self) -> &ProviderInstanceId {
        &self.instance_id
    }

    fn driver(&self) -> &str {
        self.flavor.driver
    }

    fn capabilities(&self) -> BoxFuture<'_, ProviderResult<ProviderCapabilities>> {
        Box::pin(async move {
            from_json((self.flavor.capabilities)()).map_err(|e| ProviderError::Protocol {
                detail: e.to_string(),
            })
        })
    }

    fn server_provider_entry(&self, _checked_at: &str) -> Option<serde_json::Value> {
        Some(lock(&self.status).entry.clone())
    }

    fn refresh_status(&self, instance: Option<serde_json::Value>) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let settings = GrokSettings::from_instance(instance.as_ref());
            self.probe(settings).await;
        })
    }

    fn open_session(
        &self,
        input: OpenSessionInput,
    ) -> BoxFuture<'_, ProviderResult<OpenedSession>> {
        Box::pin(async move {
            if !lock(&self.status).settings.enabled {
                // T3 refuses a turn on a disabled instance before any adapter call.
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
            let runtime_mode = launch_runtime_mode(&input);
            let launch = self.launch(Some(&runtime_mode));
            let policy = to_json(&input.runtime_policy);
            let config = session::Config {
                flush_interval: self.config.text_flush_interval,
                finalize_debounce: self.config.finalize_debounce,
                flavor: self.flavor,
                instance_id: self.instance_id.as_str().to_owned(),
                provider_session_id: input.provider_session_id.as_str().to_owned(),
                cwd: cwd.clone(),
                policy: policy.clone(),
                runtime_mode: policy["runtimeMode"]
                    .as_str()
                    .unwrap_or("full-access")
                    .to_owned(),
                model: to_json(&input.model_selection)["model"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned(),
                mcp_servers: input.mcp_servers.clone(),
                client_version: "0.0.0".into(),
            };
            let (tx, events) = mpsc::channel(session::EVENT_CAPACITY);
            let (session, _) = AcpSession::open(
                config,
                process_spawner(launch, cwd.clone()),
                session::system_env(),
                tx,
            )
            .await?;
            let now = SystemEnv.now();
            let row = json!({
                "id": input.provider_session_id.as_str(),
                "driver": self.flavor.driver,
                "providerInstanceId": self.instance_id.as_str(),
                "status": "ready",
                "cwd": cwd,
                "model": to_json(&input.model_selection)["model"],
                "capabilities": (self.flavor.capabilities)(),
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

/// For the conformance example and the replay tests: T3 call inputs as trait inputs.
#[doc(hidden)]
pub mod testing {
    use conn_contract::from_json;
    use conn_provider::{TurnInput, TurnMessage};
    use serde_json::Value;

    fn field<T: serde::de::DeserializeOwned>(v: &Value) -> T {
        // Test inputs come from T3's own calls; a mismatch is a broken capture.
        from_json(v.clone()).expect("a T3 call input field")
    }

    /// The TS `startTurn` input as the trait's `TurnInput`.
    pub fn turn_input(v: &Value) -> TurnInput {
        let message = &v["message"];
        TurnInput {
            native_thread_has_turns: v["nativeThreadHasTurns"].as_bool(),
            restart_continuation_of_run_id: None,
            app_context: vec![],
            app_thread: field(&v["appThread"]),
            thread_id: field(&v["threadId"]),
            run_id: field(&v["runId"]),
            run_ordinal: v["runOrdinal"]
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .unwrap_or(1),
            provider_turn_ordinal: v["providerTurnOrdinal"]
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .unwrap_or(1),
            attempt_id: field(&v["attemptId"]),
            root_node_id: field(&v["rootNodeId"]),
            provider_thread: field(&v["providerThread"]),
            message: TurnMessage {
                message_id: field(&message["messageId"]),
                text: message["text"].as_str().unwrap_or("").to_owned(),
                attachments: vec![],
                created_by: field(&message["createdBy"]),
                creation_source: field(&message["creationSource"]),
                scheduled_task_id: None,
                sender_thread_id: None,
            },
            model_selection: field(&v["modelSelection"]),
            runtime_policy: field(&v["runtimePolicy"]),
        }
    }
}
