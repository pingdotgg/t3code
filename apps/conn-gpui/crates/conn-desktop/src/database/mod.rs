//! The Database panel's backend: a read-only runner for MySQL/MariaDB, PostgreSQL and SQLite
//! (Conn's `apps/desktop/src/ipc/methods/database.ts`), its SSH tunnel (`sshTunnel.ts`), and the
//! panel's pure connection logic (`apps/web/src/database/databaseApi.ts`).
//!
//! The panel keeps one [`DatabaseRunner`] and calls [`DatabaseRunner::run`], or the typed
//! wrappers in [`api`]. Vault entries are not supported: Vault's relay only accepts Conn's code
//! signature, so a request with `vault_item_id` fails with [`VAULT_UNSUPPORTED`].

pub mod api;
mod cells;
mod runner;
mod sql;
pub mod ssh_tunnel;
mod types;

#[cfg(test)]
mod tests;

pub use runner::{DatabaseRunner, IDLE, MAX_SQL_LENGTH, ROW_LIMIT, TIMEOUT, VAULT_UNSUPPORTED};
pub use types::{
    DatabaseColumn, DatabaseConnection, DatabaseDriver, DatabaseOperation, DatabaseRequest,
    DatabaseResponse, DatabaseRow, DatabaseSsh,
};

/// Whether `sql` starts with a statement the panel runs (`select`, `with`, `show`, `describe`,
/// `desc`, `explain`, `values`, `table`, `pragma`), after leading comments.
pub fn is_reading_statement(sql: &str) -> bool {
    sql::is_reading(sql)
}
