//! Request and response types, field for field with Conn's `DesktopDatabaseRequest` and
//! `DesktopDatabaseResponse` (`packages/contracts/src/ipc.ts`).

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The rows of the result: column name to cell. Cells are strings, numbers, booleans or null.
pub type DatabaseRow = Map<String, Value>;

/// The database engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseDriver {
    /// MySQL or MariaDB.
    Mysql,
    /// PostgreSQL.
    Pgsql,
    /// A SQLite file.
    Sqlite,
}

impl DatabaseDriver {
    /// The name the panel shows (`DRIVER_LABELS`).
    pub const fn label(self) -> &'static str {
        match self {
            Self::Mysql => "MySQL / MariaDB",
            Self::Pgsql => "PostgreSQL",
            Self::Sqlite => "SQLite",
        }
    }

    /// Every driver, in the order the connection form lists them.
    pub const ALL: [Self; 3] = [Self::Mysql, Self::Pgsql, Self::Sqlite];

    pub(crate) const fn default_port(self) -> u16 {
        match self {
            Self::Pgsql => 5432,
            Self::Mysql | Self::Sqlite => 3306,
        }
    }
}

/// An SSH server to reach the database through (a conn-gpui addition: in Conn only Vault
/// entries carry SSH settings). `host` and `port` of the connection are then the database as
/// the SSH server reaches it.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSsh {
    /// An `~/.ssh/config` alias or address.
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub user: Option<String>,
    /// An SSH agent socket to authenticate with; the user's own agent when absent.
    #[serde(default)]
    pub agent: Option<String>,
}

/// Where the database is (`DesktopDatabaseConnection`).
#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseConnection {
    pub driver: DatabaseDriver,
    pub host: String,
    pub port: Option<u16>,
    /// The database name, or the SQLite file's absolute path.
    pub database: String,
    pub username: String,
    pub password: String,
    /// A Vault Database entry. conn-gpui cannot read Vault, so such connections fail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vault_item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh: Option<DatabaseSsh>,
}

impl fmt::Debug for DatabaseConnection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DatabaseConnection")
            .field("driver", &self.driver)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("database", &self.database)
            .field("username", &self.username)
            .field(
                "password",
                &if self.password.is_empty() {
                    ""
                } else {
                    "<redacted>"
                },
            )
            .field("vault_item_id", &self.vault_item_id)
            .field("ssh", &self.ssh)
            .finish()
    }
}

/// What to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseOperation {
    /// List the tables and views.
    Tables,
    /// List the columns of `table`.
    Describe,
    /// Run the read-only statement `sql`.
    Query,
}

/// One call (`DesktopDatabaseRequest`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseRequest {
    pub connection: DatabaseConnection,
    /// Whether a locked Vault may ask for Touch ID. Kept for parity; unused without Vault.
    #[serde(default)]
    pub allow_unlock: bool,
    /// Close an open connection first, so a changed `.env` is read again.
    #[serde(default)]
    pub reconnect: bool,
    pub operation: DatabaseOperation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
}

impl DatabaseRequest {
    /// A request without options.
    pub fn new(connection: DatabaseConnection, operation: DatabaseOperation) -> Self {
        Self {
            connection,
            allow_unlock: false,
            reconnect: false,
            operation,
            table: None,
            sql: None,
        }
    }

    /// `tables` for `connection`.
    pub fn tables(connection: DatabaseConnection) -> Self {
        Self::new(connection, DatabaseOperation::Tables)
    }

    /// `describe` of `table`.
    pub fn describe(connection: DatabaseConnection, table: impl Into<String>) -> Self {
        Self {
            table: Some(table.into()),
            ..Self::new(connection, DatabaseOperation::Describe)
        }
    }

    /// `query` with `sql`.
    pub fn query(connection: DatabaseConnection, sql: impl Into<String>) -> Self {
        Self {
            sql: Some(sql.into()),
            ..Self::new(connection, DatabaseOperation::Query)
        }
    }

    /// Sets `reconnect`.
    #[must_use]
    pub fn reconnecting(mut self, reconnect: bool) -> Self {
        self.reconnect = reconnect;
        self
    }
}

/// A table column (`DesktopDatabaseColumn`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatabaseColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub data_type: String,
    pub nullable: bool,
    #[serde(rename = "default")]
    pub default_value: Option<String>,
    pub primary: bool,
}

/// The result of one call (`DesktopDatabaseResponse`). `error` is set instead of failing.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseResponse {
    pub error: Option<String>,
    pub tables: Vec<String>,
    pub columns: Vec<DatabaseColumn>,
    pub result_columns: Vec<String>,
    pub rows: Vec<DatabaseRow>,
    /// Rows the query returned; `truncated` when the panel kept the first 500.
    pub row_count: usize,
    pub truncated: bool,
    pub duration_ms: f64,
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests assert and use ? for setup"
)]
mod tests {
    use super::*;

    #[test]
    fn request_reads_conn_json() -> Result<(), serde_json::Error> {
        let request: DatabaseRequest = serde_json::from_value(serde_json::json!({
            "connection": {
                "driver": "pgsql", "host": "db", "port": 5432, "database": "app",
                "username": "u", "password": "p"
            },
            "operation": "describe",
            "table": "audit.events",
            "reconnect": true
        }))?;
        assert_eq!(request.connection.driver, DatabaseDriver::Pgsql);
        assert_eq!(request.operation, DatabaseOperation::Describe);
        assert!(request.reconnect, "reconnect is read");
        assert!(!request.allow_unlock, "allowUnlock defaults to false");
        Ok(())
    }

    #[test]
    fn response_writes_conn_field_names() -> Result<(), serde_json::Error> {
        let response = DatabaseResponse {
            columns: vec![DatabaseColumn {
                name: "id".into(),
                data_type: "integer".into(),
                nullable: false,
                default_value: None,
                primary: true,
            }],
            ..DatabaseResponse::default()
        };
        let json = serde_json::to_value(&response)?;
        assert_eq!(
            json,
            serde_json::json!({
                "error": null, "tables": [],
                "columns": [{"name": "id", "type": "integer", "nullable": false, "default": null, "primary": true}],
                "resultColumns": [], "rows": [], "rowCount": 0, "truncated": false, "durationMs": 0.0
            })
        );
        Ok(())
    }

    #[test]
    fn debug_hides_the_password() {
        let connection = DatabaseConnection {
            driver: DatabaseDriver::Mysql,
            host: String::new(),
            port: None,
            database: "app".into(),
            username: "root".into(),
            password: "hunter2".into(),
            vault_item_id: None,
            ssh: None,
        };
        assert!(
            !format!("{connection:?}").contains("hunter2"),
            "Debug must not print the password"
        );
    }
}
