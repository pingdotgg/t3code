//! Handler registration, one file per contract area. Each file has one owner (see README).
//! A method no file registers answers "not supported".

use std::sync::Arc;

use crate::environment::Environment;
use conn_engine::Engine;
use conn_provider::Provider;

use crate::table::MethodTable;

mod annotations;
mod files;
mod orchestration;
mod projects;
pub mod provider;
mod scheduled;
pub mod server;
mod source_control;
pub mod terminal;
pub mod vcs;

/// Services handlers may use. `None` until the owning track wires it in `main.rs`.
#[derive(Clone, Default)]
pub struct Deps {
    pub engine: Option<Arc<dyn Engine>>,
    pub providers: Vec<Arc<dyn Provider>>,
    /// Set by `main.rs`; without it the server config streams are not registered.
    pub environment: Option<Arc<Environment>>,
    /// `/mcp`; `serve.rs` builds it with `routes::mcp::service`.
    pub mcp: Option<Arc<conn_mcp::McpService>>,
    pub vcs: vcs::VcsShared,
    /// Shared with the engine host, so a thread's terminals close with it.
    pub terminals: Option<conn_terminal::TerminalManager>,
    /// Files, assets and attachments; without it those methods and routes are not served.
    pub files: Option<Arc<conn_files::Files>>,
    /// Scheduled tasks (`conn_features::scheduled`); without it `scheduledTasks.*` is not served.
    pub scheduled_tasks: Option<conn_features::scheduled::ScheduledTasks>,
    /// Annotations (`conn_features::annotations`); without it `annotations.*` is not served.
    pub annotations: Option<conn_features::annotations::Annotations>,
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
    provider::register(table, deps);
    vcs::register(table, deps);
    files::register(table, deps);
    terminal::register(table, deps);
    scheduled::register(table, deps);
    annotations::register(table, deps);
    source_control::register(table, deps);
}
