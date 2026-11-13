//! Handler registration, one file per contract area. Each file has one owner (see README).
//! A method no file registers answers "not supported".

use std::sync::Arc;

use crate::environment::Environment;
use conn_engine::Engine;
use conn_provider::Provider;

use crate::table::MethodTable;

mod files;
mod orchestration;
pub mod provider;
pub mod server;
mod terminal;
pub mod vcs;

/// Services handlers may use. `None` until the owning track wires it in `main.rs`.
#[derive(Clone, Default)]
pub struct Deps {
    pub engine: Option<Arc<dyn Engine>>,
    pub providers: Vec<Arc<dyn Provider>>,
    /// Set by `main.rs`; without it the server config streams are not registered.
    pub environment: Option<Arc<Environment>>,
    pub vcs: vcs::VcsShared,
}

pub fn register_all(table: &mut MethodTable, deps: &Deps) {
    server::register(table, deps);
    orchestration::register(table, deps);
    provider::register(table, deps);
    vcs::register(table, deps);
    files::register(table, deps);
    terminal::register(table, deps);
}
