//! `server.*` and connection-level methods. Owner: track (a), wire and pairing.

use serde_json::{Value, json};

use super::Deps;
use crate::table::MethodTable;

pub fn register(table: &mut MethodTable, _deps: &Deps) {
    table.unary("server.probe", |_, _: Value| async { Ok(json!({})) });
}
