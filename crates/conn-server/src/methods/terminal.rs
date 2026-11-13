//! `terminal.*`. `subscribeTerminalMetadata` moves here from `server.rs` when it is real.
//! Owner: the terminal track. Build the services this area needs inside `register`, from
//! `deps` (state folder, projects, engine); add a `Deps` field only for a service that
//! another area must share.

use super::Deps;
use crate::table::MethodTable;

pub fn register(_table: &mut MethodTable, _deps: &Deps) {}
