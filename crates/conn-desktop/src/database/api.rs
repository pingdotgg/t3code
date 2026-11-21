//! The Database panel's connections and calls (Conn's `apps/web/src/database/databaseApi.ts`
//! and the pure parts of `databaseStore.ts`). Connections come from the project's `.env` or are
//! added by hand.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::runner::DatabaseRunner;
use super::types::{
    DatabaseColumn, DatabaseConnection, DatabaseDriver, DatabaseRequest, DatabaseResponse,
    DatabaseRow,
};
use crate::vault::VaultDatabase;

/// Where a panel connection comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionSource {
    /// Read from the project's `.env` on every open.
    Env,
    /// Saved in the panel.
    Manual,
    /// A Vault entry. conn-gpui cannot list or open these; the variant keeps saved state
    /// readable.
    Vault,
}

/// A connection as the panel lists it (`DatabaseConnection` in `databaseApi.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelConnection {
    pub id: String,
    pub name: String,
    pub source: ConnectionSource,
    #[serde(flatten)]
    pub connection: DatabaseConnection,
    /// Vault entries: the SSH host the database is reached through.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_host: Option<String>,
    /// Vault entries: the organization's name, or none for the personal vault.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization: Option<String>,
}

/// The rows of a query the panel ran.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DatabaseQueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<DatabaseRow>,
    pub row_count: usize,
    /// The panel keeps the first 500 rows.
    pub truncated: bool,
    pub duration_ms: f64,
}

/// What an agent gets back from a query it ran in the panel (`AgentPanelDatabaseResult`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDatabaseResult {
    pub connection: String,
    pub columns: Vec<String>,
    pub row_count: usize,
    /// The first rows only; long values are cut.
    pub rows: Vec<DatabaseRow>,
    pub truncated: bool,
}

const ENV_CONNECTION_ID: &str = "env";
const AGENT_ROWS: usize = 20;
const AGENT_VALUE_CHARS: usize = 500;

/// `KEY=value` lines; quotes stripped, comments and `export ` prefixes ignored.
pub fn parse_dot_env(contents: &str) -> BTreeMap<String, String> {
    let mut values = BTreeMap::new();
    for raw in contents.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = match line.strip_prefix("export") {
            Some(rest) if rest.starts_with(char::is_whitespace) => rest.trim_start(),
            _ => line,
        };
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim_end();
        let valid_key = key.chars().enumerate().all(|(index, c)| {
            c == '_' || c.is_ascii_alphabetic() || (index > 0 && c.is_ascii_digit())
        });
        if key.is_empty() || !valid_key {
            continue;
        }
        let mut value = value.trim();
        let quoted = value.len() >= 2
            && (value.starts_with('"') || value.starts_with('\''))
            && value.ends_with(&value[..1]);
        let value = if quoted {
            value[1..value.len() - 1].to_owned()
        } else {
            // An unquoted value ends at ` #`.
            if let Some(at) = value
                .char_indices()
                .find(|&(at, c)| c == '#' && at > 0 && value[..at].ends_with(char::is_whitespace))
                .map(|(at, _)| at)
            {
                value = value[..at].trim_end();
            }
            value.to_owned()
        };
        values.insert(key.to_owned(), value);
    }
    values
}

fn driver_for(connection: Option<&str>) -> Option<DatabaseDriver> {
    match connection.unwrap_or("").to_lowercase().as_str() {
        "mysql" | "mariadb" => Some(DatabaseDriver::Mysql),
        "pgsql" | "postgres" | "postgresql" => Some(DatabaseDriver::Pgsql),
        "sqlite" => Some(DatabaseDriver::Sqlite),
        _ => None,
    }
}

fn join_path(root: &str, path: &str) -> String {
    let bytes = path.as_bytes();
    let windows_absolute = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\');
    if path.starts_with('/') || windows_absolute {
        return path.to_owned();
    }
    format!("{}/{path}", root.trim_end_matches(['/', '\\']))
}

/// `parseInt`: leading digits, after an optional sign.
fn parse_port(value: &str) -> Option<u16> {
    let value = value.trim_start();
    let digits: String = value.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// The Laravel-style `DB_*` connection in a project's `.env`, or none when it has none.
pub fn connection_from_env(contents: &str, project_root: &str) -> Option<PanelConnection> {
    let env = parse_dot_env(contents);
    let get = |key: &str| env.get(key).map(String::as_str);
    let driver = driver_for(get("DB_CONNECTION"))?;
    let database = if driver == DatabaseDriver::Sqlite {
        let path = get("DB_DATABASE")
            .filter(|path| !path.is_empty())
            .unwrap_or("database/database.sqlite");
        join_path(project_root, path)
    } else {
        get("DB_DATABASE").unwrap_or("").to_owned()
    };
    Some(PanelConnection {
        id: ENV_CONNECTION_ID.to_owned(),
        name: ".env".to_owned(),
        source: ConnectionSource::Env,
        connection: DatabaseConnection {
            driver,
            host: get("DB_HOST").unwrap_or("127.0.0.1").to_owned(),
            port: get("DB_PORT").and_then(parse_port),
            database,
            username: get("DB_USERNAME").unwrap_or("").to_owned(),
            password: get("DB_PASSWORD").unwrap_or("").to_owned(),
            vault_item_id: None,
            ssh: None,
        },
        ssh_host: None,
        organization: None,
    })
}

/// `host:port/database` for the menu; the file name for SQLite.
pub fn connection_target(connection: &DatabaseConnection, ssh_host: Option<&str>) -> String {
    if connection.driver == DatabaseDriver::Sqlite {
        return connection
            .database
            .rsplit(['/', '\\'])
            .next()
            .filter(|name| !name.is_empty())
            .unwrap_or(&connection.database)
            .to_owned();
    }
    let ssh_host = ssh_host.or(connection.ssh.as_ref().map(|ssh| ssh.host.as_str()));
    if let Some(ssh_host) = ssh_host.filter(|host| !host.is_empty()) {
        return format!("{} via {ssh_host}", connection.database);
    }
    match connection.port {
        Some(port) if port != 0 => format!("{}:{port}/{}", connection.host, connection.database),
        _ => format!("{}/{}", connection.host, connection.database),
    }
}

/// The connection picked before, else the project's `.env` one, else the first.
pub fn default_connection<'a>(
    connections: &'a [PanelConnection],
    remembered: Option<&str>,
) -> Option<&'a PanelConnection> {
    connections
        .iter()
        .find(|connection| Some(connection.id.as_str()) == remembered)
        .or_else(|| {
            connections
                .iter()
                .find(|connection| connection.source == ConnectionSource::Env)
        })
        .or_else(|| connections.first())
}

/// A connection by its id or its name as the panel lists it, ignoring case.
pub fn find_connection<'a>(
    connections: &'a [PanelConnection],
    name: &str,
) -> Option<&'a PanelConnection> {
    let needle = name.trim().to_lowercase();
    connections
        .iter()
        .find(|connection| connection.id == name)
        .or_else(|| {
            connections
                .iter()
                .find(|connection| connection.name.trim().to_lowercase() == needle)
        })
}

/// Changes whenever anything that reaches the database changes, so loads run again.
pub fn connection_key(connection: &PanelConnection) -> String {
    let DatabaseConnection {
        driver,
        host,
        port,
        database,
        username,
        password,
        ..
    } = &connection.connection;
    serde_json::to_string(&(
        &connection.id,
        driver,
        host,
        port,
        database,
        username,
        password,
    ))
    .unwrap_or_default()
}

/// The first rows of a query an agent ran, with long values cut.
pub fn agent_query_result(
    connection: &PanelConnection,
    result: &DatabaseQueryResult,
) -> AgentDatabaseResult {
    let cut = |value: &Value| match value {
        Value::String(text) if text.chars().count() > AGENT_VALUE_CHARS => {
            let mut short: String = text.chars().take(AGENT_VALUE_CHARS).collect();
            short.push('…');
            Value::String(short)
        }
        other => other.clone(),
    };
    AgentDatabaseResult {
        connection: connection.name.clone(),
        columns: result.columns.clone(),
        row_count: result.row_count,
        rows: result
            .rows
            .iter()
            .take(AGENT_ROWS)
            .map(|row| {
                row.iter()
                    .map(|(key, value)| (key.clone(), cut(value)))
                    .collect()
            })
            .collect(),
        truncated: result.truncated || result.rows.len() > AGENT_ROWS,
    }
}

/// `select * from <table> limit 100`, with the driver's identifier quoting.
pub fn browse_table_sql(driver: DatabaseDriver, table: &str) -> String {
    if driver == DatabaseDriver::Mysql {
        return format!("select * from `{}` limit 100", table.replace('`', "``"));
    }
    let quote = |part: &str| format!("\"{}\"", part.replace('"', "\"\""));
    // PostgreSQL lists tables outside `public` as `schema.table`.
    let name = match table.split_once('.') {
        Some((schema, rest)) if driver == DatabaseDriver::Pgsql => {
            format!("{}.{}", quote(schema), quote(rest))
        }
        _ => quote(table),
    };
    format!("select * from {name} limit 100")
}

/// A new manual connection, copying `from`'s target when given.
pub fn new_connection(from: Option<&PanelConnection>) -> PanelConnection {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos() as u64);
    let seed = nanos ^ COUNTER.fetch_add(1, Ordering::Relaxed).rotate_left(32);
    let mut id = String::new();
    let mut rest = seed;
    for _ in 0..8 {
        let digit = (rest % 36) as u32;
        id.push(char::from_digit(digit, 36).unwrap_or('0'));
        rest /= 36;
    }
    let connection = from.map_or_else(
        || DatabaseConnection {
            driver: DatabaseDriver::Mysql,
            host: "127.0.0.1".to_owned(),
            port: None,
            database: String::new(),
            username: String::new(),
            password: String::new(),
            vault_item_id: None,
            ssh: None,
        },
        |from| from.connection.clone(),
    );
    PanelConnection {
        id,
        name: String::new(),
        source: ConnectionSource::Manual,
        connection,
        ssh_host: from.and_then(|from| from.ssh_host.clone()),
        organization: from.and_then(|from| from.organization.clone()),
    }
}

// ─── Calls ───────────────────────────────────────────────────────────────────

/// Converts a [`VaultDatabase`] listing entry into a [`PanelConnection`] (never holds a password).
#[must_use]
pub fn panel_connection_from_vault(db: &VaultDatabase) -> PanelConnection {
    PanelConnection {
        id: format!("vault:{}", db.id),
        name: db.name.clone(),
        source: ConnectionSource::Vault,
        connection: DatabaseConnection {
            driver: db.driver,
            host: db.host.clone(),
            port: Some(db.port),
            database: db.database.clone(),
            username: db.username.clone(),
            password: String::new(),
            vault_item_id: Some(db.id.clone()),
            ssh: None,
        },
        ssh_host: db.ssh_host.clone(),
        organization: db.organization.clone(),
    }
}

/// Options for one call.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CallOptions {
    /// Close the open connection first, so changed credentials are read again.
    pub reconnect: bool,
    /// Allow Vault to prompt for Touch ID / unlock on this explicit user action.
    pub allow_unlock: bool,
}

/// A failed call, with the message the panel shows.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct DatabaseCallError(pub String);

/// `UNREACHABLE` in `databaseApi.ts`, plus the macOS wording of the same failures.
fn unreachable_error(message: &str) -> bool {
    let lower = message.to_lowercase();
    [
        "econnrefused",
        "etimedout",
        "enotfound",
        "ehostunreach",
        "connect timeout",
        "connect_timeout",
        "timed out",
        "connection refused",
        "no route to host",
        "failed to lookup address",
        "nodename nor servname",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

/// The message for a failed call; unreachable hosts get a hint.
pub fn call_error_message(error: &str) -> String {
    if unreachable_error(error) {
        format!(
            "{error}. The desktop app connects from this Mac; for a database on another machine, add a connection with a host this Mac can reach."
        )
    } else {
        error.to_owned()
    }
}

async fn call(
    runner: &DatabaseRunner,
    request: DatabaseRequest,
    options: CallOptions,
) -> Result<DatabaseResponse, DatabaseCallError> {
    let mut request = request.reconnecting(options.reconnect);
    request.allow_unlock = options.allow_unlock;
    let response = runner.run(&request).await;
    match &response.error {
        Some(error) => Err(DatabaseCallError(call_error_message(error))),
        None => Ok(response),
    }
}

/// The tables and views of the database.
pub async fn list_database_tables(
    runner: &DatabaseRunner,
    connection: &DatabaseConnection,
    options: CallOptions,
) -> Result<Vec<String>, DatabaseCallError> {
    Ok(
        call(runner, DatabaseRequest::tables(connection.clone()), options)
            .await?
            .tables,
    )
}

/// The columns of `table`.
pub async fn describe_database_table(
    runner: &DatabaseRunner,
    connection: &DatabaseConnection,
    table: &str,
    options: CallOptions,
) -> Result<Vec<DatabaseColumn>, DatabaseCallError> {
    Ok(call(
        runner,
        DatabaseRequest::describe(connection.clone(), table),
        options,
    )
    .await?
    .columns)
}

/// Runs a read-only statement.
pub async fn run_read_only_query(
    runner: &DatabaseRunner,
    connection: &DatabaseConnection,
    sql: &str,
    options: CallOptions,
) -> Result<DatabaseQueryResult, DatabaseCallError> {
    let response = call(
        runner,
        DatabaseRequest::query(connection.clone(), sql),
        options,
    )
    .await?;
    Ok(DatabaseQueryResult {
        columns: response.result_columns,
        rows: response.rows,
        row_count: response.row_count,
        truncated: response.truncated,
        duration_ms: response.duration_ms,
    })
}

// ─── Saved state ─────────────────────────────────────────────────────────────

/// A project's saved connections, picked connection and SQL per connection
/// (`DatabaseProjectState` in `databaseStore.ts`). Passwords included.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseProjectState {
    pub connection: Option<String>,
    pub connections: Vec<PanelConnection>,
    pub sql_by_connection: HashMap<String, String>,
}

impl DatabaseProjectState {
    /// Picks the connection `id`.
    pub fn set_connection(&mut self, id: &str) {
        self.connection = Some(id.to_owned());
    }

    /// Adds the connection, or replaces the saved one with its id; it becomes the picked one.
    pub fn save_connection(&mut self, connection: PanelConnection) {
        self.connection = Some(connection.id.clone());
        match self
            .connections
            .iter_mut()
            .find(|saved| saved.id == connection.id)
        {
            Some(saved) => *saved = connection,
            None => self.connections.push(connection),
        }
    }

    /// Removes the connection and its SQL.
    pub fn remove_connection(&mut self, id: &str) {
        self.sql_by_connection.remove(id);
        if self.connection.as_deref() == Some(id) {
            self.connection = None;
        }
        self.connections.retain(|saved| saved.id != id);
    }

    /// Keeps the editor's SQL for a connection.
    pub fn set_sql(&mut self, connection_id: &str, sql: impl Into<String>) {
        self.sql_by_connection
            .insert(connection_id.to_owned(), sql.into());
    }

    /// The editor's SQL for a connection, empty when none.
    pub fn sql(&self, connection_id: &str) -> &str {
        self.sql_by_connection
            .get(connection_id)
            .map_or("", String::as_str)
    }
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests assert and use ? for setup"
)]
mod tests {
    use super::*;

    fn env(contents: &str, root: &str) -> Result<PanelConnection, String> {
        connection_from_env(contents, root).ok_or_else(|| format!("no connection in {contents}"))
    }

    #[test]
    fn reads_env_values_with_quotes_comments_and_export_prefixes() {
        let values = parse_dot_env(
            "# app\nexport DB_HOST=\"10.0.0.1\"\nDB_PASSWORD='p#ss word'\nDB_PORT=3307 # dev",
        );
        let expected: BTreeMap<String, String> = [
            ("DB_HOST", "10.0.0.1"),
            ("DB_PASSWORD", "p#ss word"),
            ("DB_PORT", "3307"),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect();
        assert_eq!(values, expected);
        assert_eq!(
            parse_dot_env("A=b#c").get("A").map(String::as_str),
            Some("b#c")
        );
        assert!(
            parse_dot_env("1A=x\nnot a line").is_empty(),
            "invalid keys are skipped"
        );
    }

    #[test]
    fn builds_the_project_connection_from_laravel_db_keys() -> Result<(), String> {
        let shop = env(
            "DB_CONNECTION=mariadb\nDB_HOST=127.0.0.1\nDB_PORT=3306\nDB_DATABASE=shop\nDB_USERNAME=root\nDB_PASSWORD=",
            "/srv/shop",
        )?;
        assert_eq!(shop.connection.driver, DatabaseDriver::Mysql);
        assert_eq!(shop.connection.port, Some(3306));
        assert_eq!(shop.connection.database, "shop");
        assert_eq!(shop.connection.username, "root");
        assert_eq!(shop.source, ConnectionSource::Env);
        assert_eq!(
            env("DB_CONNECTION=sqlite", "/srv/shop/")?
                .connection
                .database,
            "/srv/shop/database/database.sqlite"
        );
        assert_eq!(
            env("DB_CONNECTION=sqlite\nDB_DATABASE=/abs/db.sqlite", "/srv")?
                .connection
                .database,
            "/abs/db.sqlite"
        );
        assert!(
            connection_from_env("APP_NAME=x", "/srv/shop").is_none(),
            "no DB_CONNECTION"
        );
        Ok(())
    }

    #[test]
    fn prefers_the_picked_connection_then_the_env_one() -> Result<(), String> {
        let from_env = env("DB_CONNECTION=pgsql\nDB_DATABASE=shop", "/srv")?;
        let saved = PanelConnection {
            id: "a1".into(),
            name: "staging".into(),
            source: ConnectionSource::Manual,
            ..from_env.clone()
        };
        let pick = |list: &[PanelConnection], remembered| {
            default_connection(list, remembered).map(|connection| connection.id.clone())
        };
        assert_eq!(
            pick(&[from_env.clone(), saved.clone()], Some("a1")),
            Some("a1".into())
        );
        assert_eq!(
            pick(&[saved.clone(), from_env.clone()], None),
            Some("env".into())
        );
        assert_eq!(pick(&[], None), None);
        let both = [from_env, saved];
        let find = |name| find_connection(&both, name).map(|connection| connection.id.clone());
        assert_eq!(find(" Staging "), Some("a1".into()));
        assert_eq!(find("a1"), Some("a1".into()));
        assert_eq!(find("prod"), None);
        Ok(())
    }

    #[test]
    fn gives_an_agent_the_first_rows_with_long_values_cut() -> Result<(), String> {
        let connection = env("DB_CONNECTION=sqlite\nDB_DATABASE=db.sqlite", "/srv")?;
        let rows = (0..25)
            .map(|index| {
                let mut row = DatabaseRow::new();
                row.insert("id".into(), Value::from(index));
                row.insert("body".into(), Value::String("x".repeat(600)));
                row
            })
            .collect();
        let result = agent_query_result(
            &connection,
            &DatabaseQueryResult {
                columns: vec!["id".into(), "body".into()],
                rows,
                row_count: 25,
                truncated: false,
                duration_ms: 3.0,
            },
        );
        assert_eq!(result.rows.len(), 20);
        assert!(result.truncated, "more rows than an agent gets");
        let body = result.rows[0]
            .get("body")
            .map(|value| value.as_str().map(|text| text.chars().count()));
        assert_eq!(body, Some(Some(501)));
        assert_eq!(result.row_count, 25);
        Ok(())
    }

    #[test]
    fn quotes_table_names_the_way_the_driver_expects() {
        assert_eq!(
            browse_table_sql(DatabaseDriver::Mysql, "order`s"),
            "select * from `order``s` limit 100"
        );
        assert_eq!(
            browse_table_sql(DatabaseDriver::Pgsql, "audit.events"),
            "select * from \"audit\".\"events\" limit 100"
        );
        assert_eq!(
            browse_table_sql(DatabaseDriver::Sqlite, "users"),
            "select * from \"users\" limit 100"
        );
    }

    #[test]
    fn targets_read_host_port_and_database() -> Result<(), String> {
        let shop = env(
            "DB_CONNECTION=pgsql\nDB_HOST=10.44.0.7\nDB_PORT=5432\nDB_DATABASE=ohdear",
            "/",
        )?;
        assert_eq!(
            connection_target(&shop.connection, None),
            "10.44.0.7:5432/ohdear"
        );
        assert_eq!(
            connection_target(&shop.connection, Some("sfmain1")),
            "ohdear via sfmain1"
        );
        let file = env("DB_CONNECTION=sqlite", "/srv/shop")?;
        assert_eq!(connection_target(&file.connection, None), "database.sqlite");
        Ok(())
    }

    #[test]
    fn unreachable_hosts_get_a_hint() {
        assert!(
            call_error_message("Connection refused (os error 61)")
                .ends_with("a host this Mac can reach.")
        );
        assert_eq!(call_error_message("syntax error"), "syntax error");
    }

    #[test]
    fn project_state_saves_replaces_and_removes() {
        let mut state = DatabaseProjectState::default();
        let first = new_connection(None);
        let id = first.id.clone();
        assert_eq!(id.len(), 8);
        assert_ne!(new_connection(None).id, id, "ids differ");
        state.save_connection(first.clone());
        state.set_sql(&id, "select 1");
        state.save_connection(PanelConnection {
            name: "renamed".into(),
            ..first
        });
        assert_eq!(state.connections.len(), 1);
        assert_eq!(state.connections[0].name, "renamed");
        assert_eq!(state.connection.as_deref(), Some(id.as_str()));
        assert_eq!(state.sql(&id), "select 1");
        state.remove_connection(&id);
        assert!(state.connections.is_empty(), "removed");
        assert_eq!(state.connection, None);
        assert_eq!(state.sql(&id), "");
    }

    #[test]
    fn panel_connections_persist_in_conn_shape() -> Result<(), serde_json::Error> {
        let connection = new_connection(None);
        let json = serde_json::to_value(&connection)?;
        assert_eq!(json["driver"], "mysql");
        assert_eq!(json["source"], "manual");
        assert!(json.get("vaultItemId").is_none(), "no Vault id");
        let back: PanelConnection = serde_json::from_value(json)?;
        assert_eq!(back, connection);
        Ok(())
    }
}
