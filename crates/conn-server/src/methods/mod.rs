//! Handler registration, one file per contract area. Each file has one owner (see README).
//! A method no file registers answers "not supported".

use std::sync::Arc;

use conn_engine::Engine;
use conn_provider::Provider;

use crate::table::MethodTable;

mod orchestration;
mod provider;
mod server;

/// Services handlers may use. `None` until the owning track wires it in `main.rs`.
#[derive(Clone, Default)]
pub struct Deps {
    pub engine: Option<Arc<dyn Engine>>,
    pub providers: Vec<Arc<dyn Provider>>,
}

pub fn register_all(table: &mut MethodTable, deps: &Deps) {
    server::register(table, deps);
    orchestration::register(table, deps);
    provider::register(table, deps);
}
