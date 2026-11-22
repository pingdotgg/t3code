//! A device host: this machine or an SSH host. Both run expo-device-hub and, for agents, one
//! agent-device daemon; `Ready` is a running hub and how to run commands next to it.

use std::sync::Arc;

use crate::{
    local::LocalHost,
    model::{Availability, HostSummary},
    ssh::{self, SshConfig, SshFailure, SshHost},
};

/// `onPhase`: `installing` or `starting`, with a detail.
pub(crate) type OnPhase<'a> = dyn Fn(&str, Option<String>) + Send + Sync + 'a;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AgentEndpoint {
    pub(crate) base_url: String,
    pub(crate) token: String,
    pub(crate) entry_path: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Helpers {
    pub(crate) ax_settings: Option<String>,
    pub(crate) sim_cli: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RunResult {
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) code: i64,
}

#[derive(Clone, Debug)]
pub(crate) enum Runner {
    Local(Arc<crate::local::LocalEnv>),
    Ssh { config: SshConfig, owner: String },
}

/// A running hub.
#[derive(Clone, Debug)]
pub(crate) struct Ready {
    pub(crate) host_id: String,
    pub(crate) hub_origin: String,
    pub(crate) node_path: String,
    /// The host's shared agent-device daemon, once agent access started it.
    pub(crate) agent: Option<AgentEndpoint>,
    pub(crate) helpers: Helpers,
    pub(crate) runner: Runner,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct RunOptions {
    pub(crate) timeout_ms: Option<u64>,
    pub(crate) stdin: Option<String>,
    pub(crate) max_output: Option<usize>,
}

impl Ready {
    /// `DeviceHostReady.run`: a command next to the hub; never fails, the exit code tells.
    pub(crate) async fn run(
        &self,
        command: &str,
        args: &[String],
        options: RunOptions,
    ) -> RunResult {
        match &self.runner {
            Runner::Local(env) => env.run(command, args, options).await,
            Runner::Ssh { config, owner } => {
                ssh::run_remote(
                    config,
                    owner,
                    command,
                    args,
                    options.stdin,
                    options.timeout_ms,
                )
                .await
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum HostErrorKind {
    Ssh(Box<SshFailure>),
    SshConnect(String),
    SshWindows,
    NpmMissing,
    NodeMissing,
    Timeout(u64),
    AgentStart(String),
    Other(String),
}

/// `DeviceHostError` and its siblings: a step and why it failed.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct HostError {
    pub(crate) host_id: String,
    pub(crate) step: String,
    pub(crate) kind: HostErrorKind,
}

pub(crate) const NPM_MISSING: &str = "Device support needs npm, which is not on the Conn Server's PATH. Install npm (it comes with Node.js from nodejs.org), restart Conn, then retry.";

pub(crate) fn node_missing(feature: &str) -> String {
    format!(
        "{feature} requires Node.js. Install Node.js and make sure node is on PATH, then retry."
    )
}

impl HostError {
    pub(crate) fn new(host_id: &str, step: &str, kind: HostErrorKind) -> Self {
        Self {
            host_id: host_id.to_owned(),
            step: step.to_owned(),
            kind,
        }
    }

    /// The error's own message.
    pub(crate) fn message(&self) -> String {
        match &self.kind {
            HostErrorKind::NodeMissing => node_missing("Local device support"),
            HostErrorKind::Timeout(ms) => format!(
                "Device host {} did not start agent tools within {ms} ms.",
                self.host_id
            ),
            HostErrorKind::AgentStart(message) => message.clone(),
            _ => format!("Device host {} failed while {}.", self.host_id, self.step),
        }
    }

    /// `actionableHostFailure`: a text the user can act on, when there is one.
    pub(crate) fn actionable(&self) -> Option<String> {
        if self.step == "probe" {
            return Some(ssh::probe_failure_message(&self.kind));
        }
        (self.kind == HostErrorKind::NpmMissing).then(|| NPM_MISSING.to_owned())
    }

    /// The `reason` a `DeviceHostUnavailableError` carries for this failure.
    pub(crate) fn reason(&self, agent: bool) -> String {
        match &self.kind {
            HostErrorKind::NodeMissing => node_missing("Local device support"),
            HostErrorKind::Timeout(ms) if agent => {
                format!("Agent tools did not start within {ms} ms.")
            }
            HostErrorKind::AgentStart(message) if agent => message.clone(),
            _ => self
                .actionable()
                .unwrap_or_else(|| format!("Device support failed during {}.", self.step)),
        }
    }

    /// The detail a failed host status shows.
    pub(crate) fn detail(&self) -> String {
        self.actionable().unwrap_or_else(|| self.message())
    }
}

#[derive(Clone, Debug)]
pub(crate) enum Host {
    Local(Arc<LocalHost>),
    Ssh(Arc<SshHost>),
}

impl Host {
    pub(crate) fn id(&self) -> &str {
        match self {
            Host::Local(_) => crate::model::LOCAL_HOST_ID,
            Host::Ssh(host) => &host.config.id,
        }
    }

    pub(crate) fn label(&self) -> &str {
        match self {
            Host::Local(_) => crate::model::LOCAL_HOST_LABEL,
            Host::Ssh(host) => &host.config.label,
        }
    }

    pub(crate) fn is_ssh(&self) -> bool {
        matches!(self, Host::Ssh(_))
    }

    pub(crate) fn same(&self, other: &Host) -> bool {
        match (self, other) {
            (Host::Local(a), Host::Local(b)) => Arc::ptr_eq(a, b),
            (Host::Ssh(a), Host::Ssh(b)) => Arc::ptr_eq(a, b),
            _ => false,
        }
    }

    pub(crate) async fn summary(&self) -> HostSummary {
        match self {
            Host::Local(host) => host.summary().await,
            Host::Ssh(host) => host.summary(),
        }
    }

    pub(crate) async fn inspect(&self) -> Result<HostSummary, HostError> {
        match self {
            Host::Local(host) => Ok(host.summary().await),
            Host::Ssh(host) => host.inspect().await,
        }
    }

    pub(crate) async fn platform_availability(&self, platform: &str) -> Availability {
        match self {
            Host::Local(host) => host.platform_availability(platform).await,
            Host::Ssh(host) => host.platform_availability(platform).await,
        }
    }

    pub(crate) async fn platform_available(&self, platform: &str) -> bool {
        match self {
            Host::Local(host) => host.platform_availability(platform).await.available,
            Host::Ssh(host) => host.platform_available(platform).await,
        }
    }

    pub(crate) async fn ensure_ready(&self, on_phase: &OnPhase<'_>) -> Result<Ready, HostError> {
        match self {
            Host::Local(host) => host.ensure_ready(on_phase).await,
            Host::Ssh(host) => host.ensure_ready(on_phase).await,
        }
    }

    pub(crate) async fn ensure_agent_ready(
        &self,
        on_phase: &OnPhase<'_>,
    ) -> Result<Ready, HostError> {
        match self {
            Host::Local(host) => host.ensure_agent_ready(on_phase).await,
            Host::Ssh(host) => host.ensure_agent_ready(on_phase).await,
        }
    }

    pub(crate) fn current(&self) -> Option<Ready> {
        match self {
            Host::Local(host) => host.current(),
            Host::Ssh(host) => host.current(),
        }
    }

    pub(crate) async fn stop_agent(&self) {
        match self {
            Host::Local(host) => host.stop_agent().await,
            Host::Ssh(host) => host.stop_agent().await,
        }
    }

    /// Stops helpers. Devices keep running; the user owns those.
    pub(crate) async fn stop(&self) {
        match self {
            Host::Local(host) => host.stop().await,
            Host::Ssh(host) => host.stop().await,
        }
    }
}
