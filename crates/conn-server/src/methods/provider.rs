//! `provider.*` methods (provider status, models, auth). Owner: track (c), Claude provider.
//! Register only what Conn needs to start a Claude turn.

use super::Deps;
use crate::table::MethodTable;

pub fn register(_table: &mut MethodTable, _deps: &Deps) {}
