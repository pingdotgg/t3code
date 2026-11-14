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
#[rustfmt::skip]
mod instructions;
mod mapper;
mod ordered;
mod policy;
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
/// How long a stopped agent may take before SIGKILL (Effect's `forceKillAfter`).
const FORCE_KILL_AFTER: Duration = Duration::from_secs(2);

/// One configured ACP agent instance.
#[derive(Clone, Debug)]
pub struct AcpConfig {
    /// The executable: the user's setting, or the flavor's default name on `PATH`.
    pub binary: String,
    /// The instance's own environment entries, added to the inherited environment.
    pub environment: Vec<(String, String)>,
}

pub struct AcpProvider {
    instance_id: ProviderInstanceId,
    flavor: &'static Flavor,
    config: AcpConfig,
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
    pub fn new(
        instance_id: ProviderInstanceId,
        flavor: &'static Flavor,
        config: AcpConfig,
    ) -> Self {
        Self {
            instance_id,
            flavor,
            config,
        }
    }

    /// The launch for a runtime mode (Grok: `grokLaunchRuntimeMode` of the policy).
    pub fn launch(&self, runtime_mode: Option<&str>) -> Launch {
        (self.flavor.launch)(&self.config.binary, runtime_mode, &self.config.environment)
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
            stop: Box::new(move || Box::pin(process.terminate(FORCE_KILL_AFTER))),
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

    fn open_session(
        &self,
        input: OpenSessionInput,
    ) -> BoxFuture<'_, ProviderResult<OpenedSession>> {
        Box::pin(async move {
            let cwd = input.runtime_policy.cwd.clone().unwrap_or_else(|| {
                std::env::current_dir()
                    .map(|d| d.display().to_string())
                    .unwrap_or_default()
            });
            let runtime_mode = launch_runtime_mode(&input);
            let launch = self.launch(Some(&runtime_mode));
            let policy = to_json(&input.runtime_policy);
            let config = session::Config {
                flush_interval: Some(session::FLUSH_INTERVAL),
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
