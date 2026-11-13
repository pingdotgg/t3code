//! `orchestration.*` methods, backed by [`conn_engine::Engine`]. Owner: track (d), engine.
//!
//! Register `orchestration.dispatchCommand`, `orchestration.subscribeShell` and
//! `orchestration.subscribeThread` here once `deps.engine` is set. Map
//! `EngineError::Rejected` to `Failure::fail` and `EngineError::Internal` to `Failure::die`.

use super::Deps;
use crate::table::MethodTable;

pub fn register(_table: &mut MethodTable, _deps: &Deps) {}
