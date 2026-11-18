//! Handler registration, one file per contract area. Each file has one owner (see README).
//! A method no file registers answers "not supported".

use std::sync::Arc;

use crate::environment::Environment;
use conn_engine::Engine;

use crate::table::MethodTable;

mod annotations;
mod files;
mod git;
mod git_message;
mod mcp_apps;
pub(crate) mod orchestration;
mod panels;
mod preview;
mod projects;
pub mod provider;
pub(crate) mod pull_requests;
mod scheduled;
mod secrets;
pub mod server;
mod source_control;
pub mod terminal;
mod test_logins;
mod text_generation;
pub mod vcs;

/// Services handlers may use. `None` until the owning track wires it in `main.rs`.
#[derive(Clone, Default)]
pub struct Deps {
    pub preview: Option<conn_preview::tabs::Preview>,
    pub engine: Option<Arc<dyn Engine>>,
    /// The provider instances; `instances` changes them as the settings change.
    pub providers: conn_provider::ProviderSet,
    /// Builds Claude and Codex instances from `providerInstances` (`crate::instances`).
    pub instances: Option<Arc<crate::instances::Instances>>,
    /// Set by `main.rs`; without it the server config streams are not registered.
    pub environment: Option<Arc<Environment>>,
    /// `/mcp`; `serve.rs` builds it with `routes::mcp::service`.
    pub mcp: Option<Arc<conn_mcp::McpService>>,
    pub vcs: vcs::VcsShared,
    /// One PR service for RPC reads, refreshes and HTTP diffs.
    pub pull_requests: pull_requests::Shared,
    /// Shared with the engine host, so a thread's terminals close with it.
    pub terminals: Option<conn_terminal::TerminalManager>,
    /// Files, assets and attachments; without it those methods and routes are not served.
    pub files: Option<Arc<conn_files::Files>>,
    /// Scheduled tasks (`conn_features::scheduled`); without it `scheduledTasks.*` is not served.
    pub scheduled_tasks: Option<conn_features::scheduled::ScheduledTasks>,
    /// Shared by the desktop request stream and the agent panel tool.
    pub panels: Option<conn_features::panels::PanelBroker>,
    /// Shared by secret card answers and the agent secret tool.
    pub secrets: Option<conn_features::secrets::SecretRequests>,
    pub test_logins: Option<conn_features::test_logins::TestLogins>,
    /// Annotations (`conn_features::annotations`); without it `annotations.*` is not served.
    pub annotations: Option<conn_features::annotations::Annotations>,
    /// Text generators (`crate::text_generation`); without it `listTextGeneratorModels` is not
    /// served.
    pub text_generators: Option<Arc<crate::text_generation::TextGenerators>>,
    /// Bumped when a provider's `ServerProvider` entry changes (`provider::ProviderStatus`).
    pub provider_status: provider::ProviderStatus,
}

impl std::fmt::Debug for Deps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Deps")
            .field("providers", &self.providers.len())
            .field("environment", &self.environment)
            .finish_non_exhaustive()
    }
}

pub fn register_all(table: &mut MethodTable, deps: &Deps) {
    server::register(table, deps);
    orchestration::register(table, deps);
    projects::register(table, deps);
    preview::register(table, deps);
    provider::register(table, deps);
    vcs::register(table, deps);
    git::register(table, deps);
    files::register(table, deps);
    mcp_apps::register(table, deps);
    terminal::register(table, deps);
    scheduled::register(table, deps);
    secrets::register(table, deps);
    test_logins::register(table, deps);
    panels::register(table, deps);
    annotations::register(table, deps);
    source_control::register(table, deps);
    pull_requests::register(table, deps);
    text_generation::register(table, deps);
}
