#![warn(clippy::all, clippy::pedantic)]

mod migrations;
#[cfg(test)]
mod tests;

use std::path::Path;
use std::sync::Arc;

use anyhow::Context;
use rusqlite::{Connection, OpenFlags};

pub use migrations::{run_migrations, MigrationSummary, MIGRATION_COUNT};

/// Thin async-friendly wrapper around a single `SQLite` connection.
///
/// We keep a single connection for now (milestone 2) and protect it with a mutex.
/// All DB work happens on a blocking thread via `spawn_blocking` to avoid stalling Tokio.
#[derive(Clone)]
pub struct SqliteDb {
    conn: Arc<std::sync::Mutex<Connection>>,
}

impl SqliteDb {
    /// Opens (or creates) the database at `path` and runs all migrations.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be opened or migrations fail.
    pub fn open_and_migrate(path: &Path) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }

        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_FULL_MUTEX;
        let mut conn = Connection::open_with_flags(path, flags)
            .with_context(|| format!("failed to open sqlite db at {}", path.display()))?;

        // Keep behavior predictable under concurrent reads/writes.
        conn.pragma_update(None, "journal_mode", "WAL")
            .context("failed to set journal_mode=WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .context("failed to set foreign_keys=ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .context("failed to set sqlite busy_timeout")?;

        let migrations = run_migrations(&mut conn).context("migrations failed")?;
        tracing::info!(?migrations, "sqlite migrations applied");

        Ok(Self {
            conn: Arc::new(std::sync::Mutex::new(conn)),
        })
    }

    /// Runs a closure with the connection on the current thread.
    ///
    /// This is intended for one-time startup work during synchronous initialization.
    ///
    /// # Errors
    ///
    /// Returns an error if the closure returns an error.
    pub fn with_conn_blocking<F, T>(&self, f: F) -> anyhow::Result<T>
    where
        F: FnOnce(&Connection) -> anyhow::Result<T>,
    {
        let guard = self
            .conn
            .lock()
            .map_err(|_| anyhow::anyhow!("sqlite connection mutex poisoned"))?;
        f(&guard)
    }

    /// Runs a blocking closure with the underlying connection.
    ///
    /// # Errors
    ///
    /// Returns an error if the task panics or the closure returns an error.
    pub async fn with_conn<F, T>(&self, f: F) -> anyhow::Result<T>
    where
        F: FnOnce(&Connection) -> anyhow::Result<T> + Send + 'static,
        T: Send + 'static,
    {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let guard = conn
                .lock()
                .map_err(|_| anyhow::anyhow!("sqlite connection mutex poisoned"))?;
            f(&guard)
        })
        .await
        .context("sqlite blocking task join failed")?
    }

    /// Runs a blocking closure with the underlying connection mutably.
    ///
    /// # Errors
    ///
    /// Returns an error if the task panics or the closure returns an error.
    pub async fn with_conn_mut<F, T>(&self, f: F) -> anyhow::Result<T>
    where
        F: FnOnce(&mut Connection) -> anyhow::Result<T> + Send + 'static,
        T: Send + 'static,
    {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = conn
                .lock()
                .map_err(|_| anyhow::anyhow!("sqlite connection mutex poisoned"))?;
            f(&mut guard)
        })
        .await
        .context("sqlite blocking task join failed")?
    }
}
