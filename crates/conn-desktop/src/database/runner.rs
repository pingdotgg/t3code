//! The read-only runner (`runDatabase` in Conn's `database.ts`).
//!
//! One connection per database stays open and closes after [`IDLE`] without calls. MySQL
//! sessions are read-only; PostgreSQL wraps each call in a rolled-back read-only transaction;
//! SQLite opens read-only for each call.

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError, Weak};
use std::time::Duration;

use futures::TryStreamExt as _;
use serde_json::Value;
use sqlx::mysql::{MySqlConnectOptions, MySqlConnection, MySqlRow, MySqlSslMode};
use sqlx::postgres::{PgConnectOptions, PgConnection, PgRow, PgSslMode};
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection, SqliteRow};
use sqlx::{
    AssertSqlSafe, ConnectOptions as _, Connection as _, Executor as _, SqlSafeStr as _,
    Statement as _,
};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::cells::{mysql_cell, postgres_cell, sqlite_cell, text};
use super::sql::{assert_reading, first_statement};
use super::ssh_tunnel::{SSH_BINARY, SshTunnel, SshTunnelTarget, open_ssh_tunnel};
use super::types::{
    DatabaseColumn, DatabaseConnection, DatabaseDriver, DatabaseOperation, DatabaseRequest,
    DatabaseResponse, DatabaseRow, DatabaseSsh,
};
use crate::vault::{VaultClient, VaultTls};

/// The panel keeps the first rows of a result.
pub const ROW_LIMIT: usize = 500;
/// How long one statement may run.
pub const TIMEOUT: Duration = Duration::from_secs(30);
/// An open connection closes after this long without calls.
pub const IDLE: Duration = Duration::from_secs(5 * 60);
/// The longest SQL a request may carry, in bytes.
pub const MAX_SQL_LENGTH: usize = 200_000;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// The error for a Vault entry. Vault's relay only accepts Conn's code signature.
pub const VAULT_UNSUPPORTED: &str =
    "Vault connections need the Conn desktop app. Add this database here by hand to open it.";

/// Why one call failed.
#[derive(Debug)]
struct CallError {
    message: String,
    /// The server or network dropped the connection: open a new one, once.
    lost: bool,
    /// The connection is in an unknown state and must not be reused.
    broken: bool,
}

impl CallError {
    fn plain(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            lost: false,
            broken: false,
        }
    }

    fn timeout(message: &str) -> Self {
        Self {
            message: message.to_owned(),
            lost: false,
            broken: true,
        }
    }
}

/// `LOST_CONNECTION` in `database.ts`, on Rust's error text.
fn lost_text(message: &str) -> bool {
    let lower = message.to_lowercase();
    let connection_closed = lower.find("connection").is_some_and(|at| {
        let rest = &lower[at..];
        ["closed", "ended", "terminated"]
            .iter()
            .any(|word| rest.contains(word))
    });
    connection_closed
        || [
            "protocol_connection_lost",
            "econnreset",
            "epipe",
            "etimedout",
            "connection lost",
            "connection reset",
            "broken pipe",
            "can't add new command when connection is in closed state",
        ]
        .iter()
        .any(|needle| lower.contains(needle))
}

impl From<sqlx::Error> for CallError {
    fn from(error: sqlx::Error) -> Self {
        use std::io::ErrorKind;
        match error {
            sqlx::Error::Database(error) => Self::plain(error.message()),
            sqlx::Error::Io(error) => {
                let lost = matches!(
                    error.kind(),
                    ErrorKind::ConnectionReset
                        | ErrorKind::ConnectionAborted
                        | ErrorKind::BrokenPipe
                        | ErrorKind::UnexpectedEof
                        | ErrorKind::NotConnected
                ) || lost_text(&error.to_string());
                Self {
                    message: error.to_string(),
                    lost,
                    broken: lost,
                }
            }
            sqlx::Error::PoolClosed | sqlx::Error::WorkerCrashed => Self {
                message: error.to_string(),
                lost: true,
                broken: true,
            },
            other => {
                let message = other.to_string();
                let lost = lost_text(&message);
                Self {
                    message,
                    lost,
                    broken: lost,
                }
            }
        }
    }
}

type CallResult<T> = Result<T, CallError>;

// ─── Rows ────────────────────────────────────────────────────────────────────

/// The first [`ROW_LIMIT`] rows as cells, and how many there were (`limitRows`).
#[derive(Debug, Default)]
struct Limited {
    columns: Vec<String>,
    rows: Vec<DatabaseRow>,
    count: usize,
}

impl Limited {
    fn push<R>(&mut self, row: &R, cell: fn(&R, usize) -> Value) {
        if self.count < ROW_LIMIT {
            let mut out = DatabaseRow::new();
            for (index, column) in self.columns.iter().enumerate() {
                out.insert(column.clone(), cell(row, index));
            }
            self.rows.push(out);
        }
        self.count += 1;
    }

    fn into_response(self) -> DatabaseResponse {
        DatabaseResponse {
            truncated: self.count > ROW_LIMIT,
            result_columns: self.columns,
            rows: self.rows,
            row_count: self.count,
            ..DatabaseResponse::default()
        }
    }

    fn texts(&self, column: &str) -> Vec<String> {
        self.rows
            .iter()
            .map(|row| row.get(column).map(text).unwrap_or_default())
            .collect()
    }
}

fn get<'a>(row: &'a DatabaseRow, key: &str) -> &'a Value {
    row.get(key).unwrap_or(&Value::Null)
}

fn default_of(row: &DatabaseRow, key: &str) -> Option<String> {
    match get(row, key) {
        Value::Null => None,
        value => Some(text(value)),
    }
}

fn integer_of(value: &Value) -> i64 {
    match value {
        Value::Number(number) => number.as_i64().unwrap_or(0),
        Value::String(text) => text.trim().parse().unwrap_or(0),
        Value::Bool(flag) => i64::from(*flag),
        _ => 0,
    }
}

fn names<C: sqlx::Column>(columns: &[C]) -> Vec<String> {
    columns
        .iter()
        .map(|column| column.name().to_owned())
        .collect()
}

// ─── MySQL / MariaDB ─────────────────────────────────────────────────────────

const MYSQL_TIMEOUT_MESSAGE: &str = "Query inactivity timeout";

async fn open_mysql(
    host: &str,
    port: u16,
    connection: &DatabaseConnection,
    tls: Option<VaultTls>,
) -> CallResult<MySqlConnection> {
    let ssl_mode = match tls {
        None | Some(VaultTls::Disabled) => MySqlSslMode::Disabled,
        Some(VaultTls::Required) => MySqlSslMode::Required,
        Some(VaultTls::VerifyCa) => MySqlSslMode::VerifyCa,
        Some(VaultTls::VerifyFull) => MySqlSslMode::VerifyIdentity,
    };
    let mut options = MySqlConnectOptions::new()
        .host(host)
        .port(port)
        .username(&connection.username)
        .password(&connection.password)
        .ssl_mode(ssl_mode)
        // Leave the server's time zone and SQL mode alone, as `mysql2` does.
        .timezone(None)
        .pipes_as_concat(false)
        .no_engine_substitution(false);
    if !connection.database.is_empty() {
        options = options.database(&connection.database);
    }
    let mut client = match tokio::time::timeout(CONNECT_TIMEOUT, options.connect()).await {
        Ok(client) => client?,
        Err(_) => {
            return Err(CallError {
                message: "connect ETIMEDOUT".to_owned(),
                lost: true,
                broken: true,
            });
        }
    };
    // Every later statement runs read-only. `set` is not a reading statement, so a query cannot
    // undo it.
    if let Err(error) = client.execute("SET SESSION TRANSACTION READ ONLY").await {
        let _ = client.close().await;
        return Err(error.into());
    }
    Ok(client)
}

async fn mysql_rows(
    client: &mut MySqlConnection,
    sql: &str,
    binds: &[&str],
) -> CallResult<Limited> {
    // A prepared statement: MySQL runs exactly one, as `multipleStatements: false` does.
    let statement = client
        .prepare(AssertSqlSafe(sql.to_owned()).into_sql_str())
        .await?;
    let mut limited = Limited {
        columns: names(statement.columns()),
        ..Limited::default()
    };
    let mut query = statement.query();
    for bind in binds {
        query = query.bind(*bind);
    }
    let mut stream = query.fetch(&mut *client);
    while let Some(row) = stream.try_next().await? {
        limited.push::<MySqlRow>(&row, mysql_cell);
    }
    Ok(limited)
}

async fn run_mysql(
    client: &mut MySqlConnection,
    request: &DatabaseRequest,
) -> CallResult<DatabaseResponse> {
    let work = async {
        match request.operation {
            DatabaseOperation::Tables => {
                let result = mysql_rows(
                    client,
                    "select table_name as name from information_schema.tables where table_schema = database() order by table_name",
                    &[],
                )
                .await?;
                // Older servers name the column in capitals.
                let column = result.columns.first().cloned().unwrap_or_default();
                Ok(DatabaseResponse {
                    tables: result.texts(&column),
                    ..DatabaseResponse::default()
                })
            }
            DatabaseOperation::Describe => {
                let result = mysql_rows(
                    client,
                    "select column_name as name, column_type as type, is_nullable as nullable, column_default as dflt, column_key as ckey from information_schema.columns where table_schema = database() and table_name = ? order by ordinal_position",
                    &[request.table.as_deref().unwrap_or("")],
                )
                .await?;
                Ok(DatabaseResponse {
                    columns: result
                        .rows
                        .iter()
                        .map(|row| DatabaseColumn {
                            name: text(get(row, "name")),
                            data_type: text(get(row, "type")),
                            nullable: text(get(row, "nullable")) == "YES",
                            default_value: default_of(row, "dflt"),
                            primary: text(get(row, "ckey")) == "PRI",
                        })
                        .collect(),
                    ..DatabaseResponse::default()
                })
            }
            DatabaseOperation::Query => {
                Ok(
                    mysql_rows(client, request.sql.as_deref().unwrap_or(""), &[])
                        .await?
                        .into_response(),
                )
            }
        }
    };
    tokio::time::timeout(TIMEOUT, work)
        .await
        .unwrap_or_else(|_| Err(CallError::timeout(MYSQL_TIMEOUT_MESSAGE)))
}

// ─── PostgreSQL ──────────────────────────────────────────────────────────────

const POSTGRES_TIMEOUT_MESSAGE: &str = "canceling statement due to statement timeout";

async fn open_postgres(
    host: &str,
    port: u16,
    connection: &DatabaseConnection,
    tls: Option<VaultTls>,
) -> CallResult<PgConnection> {
    let ssl_mode = match tls {
        None | Some(VaultTls::Disabled) => PgSslMode::Disable,
        Some(VaultTls::Required) => PgSslMode::Require,
        Some(VaultTls::VerifyCa) => PgSslMode::VerifyCa,
        Some(VaultTls::VerifyFull) => PgSslMode::VerifyFull,
    };
    let mut options = PgConnectOptions::new_without_pgpass()
        .host(host)
        .port(port)
        .username(&connection.username)
        .password(&connection.password)
        .ssl_mode(ssl_mode);
    if !connection.database.is_empty() {
        options = options.database(&connection.database);
    }
    let mut client = match tokio::time::timeout(CONNECT_TIMEOUT, options.connect()).await {
        Ok(client) => client?,
        Err(_) => {
            return Err(CallError::plain(format!(
                "write CONNECT_TIMEOUT {host}:{port}"
            )));
        }
    };
    let setup = format!(
        "set statement_timeout = {}; set default_transaction_read_only = on",
        TIMEOUT.as_millis()
    );
    if let Err(error) = sqlx::raw_sql(AssertSqlSafe(setup))
        .execute(&mut client)
        .await
    {
        let _ = client.close().await;
        return Err(error.into());
    }
    Ok(client)
}

/// `schema.table`, or a bare table in `public`.
pub(crate) fn postgres_table(name: &str) -> (&str, &str) {
    name.split_once('.').unwrap_or(("public", name))
}

/// Runs one statement through the extended protocol, where PostgreSQL accepts one statement
/// only, so `select 1; commit; delete ...` fails instead of running three.
async fn postgres_rows(
    client: &mut PgConnection,
    sql: &str,
    binds: &[&str],
) -> CallResult<Limited> {
    let statement = client
        .prepare(AssertSqlSafe(sql.to_owned()).into_sql_str())
        .await?;
    let mut limited = Limited {
        columns: names(statement.columns()),
        ..Limited::default()
    };
    let mut query = statement.query();
    for bind in binds {
        query = query.bind(*bind);
    }
    let mut stream = query.fetch(&mut *client);
    while let Some(row) = stream.try_next().await? {
        limited.push::<PgRow>(&row, postgres_cell);
    }
    Ok(limited)
}

async fn postgres_call(
    client: &mut PgConnection,
    request: &DatabaseRequest,
) -> CallResult<DatabaseResponse> {
    match request.operation {
        DatabaseOperation::Tables => {
            let result = postgres_rows(
                client,
                "select case when table_schema = 'public' then table_name else table_schema || '.' || table_name end as name from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema') order by 1",
                &[],
            )
            .await?;
            Ok(DatabaseResponse {
                tables: result.texts("name"),
                ..DatabaseResponse::default()
            })
        }
        DatabaseOperation::Describe => {
            let (schema, table) = postgres_table(request.table.as_deref().unwrap_or(""));
            let result = postgres_rows(
                client,
                "select c.column_name as name, c.data_type as type, c.is_nullable as nullable, c.column_default as dflt,
                   exists (
                     select 1 from information_schema.table_constraints t
                     join information_schema.key_column_usage k
                       on k.constraint_name = t.constraint_name and k.table_schema = t.table_schema
                     where t.constraint_type = 'PRIMARY KEY' and k.table_schema = c.table_schema
                       and k.table_name = c.table_name and k.column_name = c.column_name
                   ) as pk
                 from information_schema.columns c
                 where c.table_schema = $1 and c.table_name = $2
                 order by c.ordinal_position",
                &[schema, table],
            )
            .await?;
            Ok(DatabaseResponse {
                columns: result
                    .rows
                    .iter()
                    .map(|row| DatabaseColumn {
                        name: text(get(row, "name")),
                        data_type: text(get(row, "type")),
                        nullable: text(get(row, "nullable")) == "YES",
                        default_value: default_of(row, "dflt"),
                        primary: get(row, "pk") == &Value::Bool(true),
                    })
                    .collect(),
                ..DatabaseResponse::default()
            })
        }
        DatabaseOperation::Query => {
            Ok(
                postgres_rows(client, request.sql.as_deref().unwrap_or(""), &[])
                    .await?
                    .into_response(),
            )
        }
    }
}

/// Runs the call inside `begin read only` … `rollback`; the rollback also undoes any setting the
/// query changed.
async fn run_postgres(
    client: &mut PgConnection,
    request: &DatabaseRequest,
) -> CallResult<DatabaseResponse> {
    let work = async {
        client.execute("begin read only").await?;
        let result = postgres_call(client, request).await;
        let _ = client.execute("rollback").await;
        result
    };
    // The server cancels at `statement_timeout`; this is the backstop for a dead network.
    tokio::time::timeout(TIMEOUT + Duration::from_secs(5), work)
        .await
        .unwrap_or_else(|_| Err(CallError::timeout(POSTGRES_TIMEOUT_MESSAGE)))
}

// ─── SQLite ──────────────────────────────────────────────────────────────────

const SQLITE_TIMEOUT_MESSAGE: &str = "The query did not finish within 30 seconds.";

async fn sqlite_rows(client: &mut SqliteConnection, sql: &str) -> CallResult<Limited> {
    // Like `node:sqlite`'s `prepare`, run the first statement only.
    let sql = first_statement(sql).to_owned();
    let statement = client.prepare(AssertSqlSafe(sql).into_sql_str()).await?;
    let mut limited = Limited {
        columns: names(statement.columns()),
        ..Limited::default()
    };
    let mut stream = statement.query().fetch(&mut *client);
    while let Some(row) = stream.try_next().await? {
        limited.push::<SqliteRow>(&row, sqlite_cell);
    }
    Ok(limited)
}

async fn sqlite_call(
    client: &mut SqliteConnection,
    request: &DatabaseRequest,
) -> CallResult<DatabaseResponse> {
    match request.operation {
        DatabaseOperation::Tables => Ok(DatabaseResponse {
            tables: sqlite_rows(
                client,
                "select name from sqlite_master where type in ('table', 'view') and name not like 'sqlite_%' order by name",
            )
            .await?
            .texts("name"),
            ..DatabaseResponse::default()
        }),
        DatabaseOperation::Describe => {
            let table = request.table.as_deref().unwrap_or("").replace('"', "\"\"");
            let result = sqlite_rows(client, &format!("pragma table_info(\"{table}\")")).await?;
            Ok(DatabaseResponse {
                columns: result
                    .rows
                    .iter()
                    .map(|row| DatabaseColumn {
                        name: text(get(row, "name")),
                        data_type: text(get(row, "type")),
                        nullable: integer_of(get(row, "notnull")) == 0,
                        default_value: default_of(row, "dflt_value"),
                        primary: integer_of(get(row, "pk")) > 0,
                    })
                    .collect(),
                ..DatabaseResponse::default()
            })
        }
        DatabaseOperation::Query => Ok(sqlite_rows(client, request.sql.as_deref().unwrap_or(""))
            .await?
            .into_response()),
    }
}

/// Opens the file read-only for this call only.
async fn run_sqlite(request: &DatabaseRequest) -> CallResult<DatabaseResponse> {
    let options = SqliteConnectOptions::new()
        .filename(&request.connection.database)
        .read_only(true)
        .create_if_missing(false);
    let mut client = options.connect().await?;
    let result = tokio::time::timeout(TIMEOUT, sqlite_call(&mut client, request))
        .await
        .unwrap_or_else(|_| Err(CallError::timeout(SQLITE_TIMEOUT_MESSAGE)));
    let _ = client.close().await;
    result
}

// ─── Open connections ────────────────────────────────────────────────────────

#[derive(Debug)]
enum Client {
    Mysql(MySqlConnection),
    Postgres(PgConnection),
}

#[derive(Debug)]
struct Session {
    client: Client,
    /// Dropped with the session, which stops `ssh`.
    tunnel: Option<SshTunnel>,
}

impl Session {
    async fn close(self) {
        match self.client {
            Client::Mysql(client) => {
                let _ = client.close().await;
            }
            Client::Postgres(client) => {
                let _ = client.close().await;
            }
        }
        drop(self.tunnel);
    }
}

/// Opens the driver connection, through an SSH tunnel when the connection names an SSH host.
async fn open_session(
    connection: &DatabaseConnection,
    tls: Option<VaultTls>,
    ssh_binary: &Path,
) -> CallResult<Session> {
    let mut host = if connection.host.is_empty() {
        "127.0.0.1".to_owned()
    } else {
        connection.host.clone()
    };
    let mut port = connection
        .port
        .unwrap_or_else(|| connection.driver.default_port());
    let mut tunnel = None;
    if let Some(ssh) = &connection.ssh {
        let target = SshTunnelTarget {
            host: ssh.host.clone(),
            port: ssh.port,
            user: ssh.user.clone(),
            agent: ssh.agent.clone(),
            remote_host: host,
            remote_port: port,
        };
        let opened = open_ssh_tunnel(&target, ssh_binary)
            .await
            .map_err(|error| CallError::plain(error.to_string()))?;
        host = "127.0.0.1".to_owned();
        port = opened.local_port();
        tunnel = Some(opened);
    }
    // On an error the tunnel drops here, which stops `ssh`.
    let client = match connection.driver {
        DatabaseDriver::Mysql => Client::Mysql(open_mysql(&host, port, connection, tls).await?),
        DatabaseDriver::Pgsql => {
            Client::Postgres(open_postgres(&host, port, connection, tls).await?)
        }
        DatabaseDriver::Sqlite => {
            return Err(CallError::plain("SQLite files open per call."));
        }
    };
    Ok(Session { client, tunnel })
}

#[derive(Debug, Default)]
struct Entry {
    /// Calls on one connection run one after another.
    session: tokio::sync::Mutex<Option<Session>>,
    /// Whether a call has succeeded. Until then an error closes it.
    proven: AtomicBool,
    idle: Mutex<Option<JoinHandle<()>>>,
}

impl Entry {
    fn stop_idle(&self) {
        if let Some(handle) = self
            .idle
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            handle.abort();
        }
    }

    async fn close(&self) {
        let session = self.session.lock().await.take();
        if let Some(session) = session {
            session.close().await;
        }
    }
}

#[derive(Debug)]
struct Inner {
    sessions: Mutex<HashMap<String, Arc<Entry>>>,
    ssh_binary: PathBuf,
    vault: VaultClient,
}

/// The Database panel's runner. Cheap to clone; clones share open connections.
///
/// Call it from a Tokio runtime: idle connections close on a timer task.
#[derive(Clone)]
pub struct DatabaseRunner {
    inner: Arc<Inner>,
}

impl fmt::Debug for DatabaseRunner {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let open = self
            .inner
            .sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len();
        f.debug_struct("DatabaseRunner")
            .field("open_connections", &open)
            .field("ssh_binary", &self.inner.ssh_binary)
            .finish()
    }
}

impl Default for DatabaseRunner {
    fn default() -> Self {
        Self::new()
    }
}

/// Connections by everything that reaches the database.
fn session_key(connection: &DatabaseConnection) -> String {
    if let Some(id) = &connection.vault_item_id {
        return format!("vault:{id}");
    }
    let DatabaseConnection {
        driver,
        host,
        port,
        database,
        username,
        password,
        ssh,
        ..
    } = connection;
    serde_json::to_string(&(driver, host, port, database, username, password, ssh))
        .unwrap_or_default()
}

impl DatabaseRunner {
    /// A runner that tunnels with the system `ssh`.
    pub fn new() -> Self {
        Self::with_ssh_binary(SSH_BINARY)
    }

    /// A runner that tunnels with `ssh_binary`.
    pub fn with_ssh_binary(ssh_binary: impl Into<PathBuf>) -> Self {
        Self::with_binaries(ssh_binary, VaultClient::new())
    }

    /// A runner using a custom Vault bridge binary (used by tests).
    pub fn with_vault_binary(vault_binary: impl Into<PathBuf>) -> Self {
        Self::with_binaries(SSH_BINARY, VaultClient::with_binary(vault_binary))
    }

    /// A runner with explicit `ssh` and Vault clients.
    pub fn with_binaries(ssh_binary: impl Into<PathBuf>, vault: VaultClient) -> Self {
        Self {
            inner: Arc::new(Inner {
                sessions: Mutex::new(HashMap::new()),
                ssh_binary: ssh_binary.into(),
                vault,
            }),
        }
    }

    /// Reference to the runner's Vault Mac bridge client.
    #[must_use]
    pub fn vault(&self) -> &VaultClient {
        &self.inner.vault
    }

    /// Runs one call. Failures come back in `error`, never as a panic or `Err`.
    pub async fn run(&self, request: &DatabaseRequest) -> DatabaseResponse {
        let started = Instant::now();
        let result = self.dispatch(request).await;
        let duration_ms = (started.elapsed().as_secs_f64() * 10_000.0).round() / 10.0;
        match result {
            Ok(response) => DatabaseResponse {
                duration_ms,
                ..response
            },
            Err(message) => DatabaseResponse {
                error: Some(message),
                duration_ms,
                ..DatabaseResponse::default()
            },
        }
    }

    /// How many network connections are open.
    pub fn open_connections(&self) -> usize {
        self.sessions().len()
    }

    /// Closes every open connection, for app shutdown.
    pub async fn close_all(&self) {
        let entries: Vec<Arc<Entry>> = self.sessions().drain().map(|(_, entry)| entry).collect();
        for entry in entries {
            entry.stop_idle();
            entry.close().await;
        }
    }

    fn sessions(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Entry>>> {
        self.inner
            .sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    async fn dispatch(&self, request: &DatabaseRequest) -> Result<DatabaseResponse, String> {
        if request.operation == DatabaseOperation::Query {
            let sql = request.sql.as_deref().unwrap_or("");
            if sql.len() > MAX_SQL_LENGTH {
                return Err(format!(
                    "The query is longer than {MAX_SQL_LENGTH} characters."
                ));
            }
            assert_reading(sql)?;
        }
        let result = match request.connection.driver {
            DatabaseDriver::Sqlite if request.connection.vault_item_id.is_none() => {
                run_sqlite(request).await
            }
            _ => self.with_session(request).await,
        };
        result.map_err(|error| error.message)
    }

    /// The open entry for `key`, or a new one.
    fn entry(&self, key: &str) -> Arc<Entry> {
        Arc::clone(
            self.sessions()
                .entry(key.to_owned())
                .or_insert_with(|| Arc::new(Entry::default())),
        )
    }

    /// Closes `entry` if it is still the open one for `key`.
    fn close_entry(&self, key: &str, entry: &Arc<Entry>) {
        Self::close_in(&self.inner, key, entry);
    }

    fn close_in(inner: &Inner, key: &str, entry: &Arc<Entry>) {
        {
            let mut sessions = inner
                .sessions
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            match sessions.get(key) {
                Some(current) if Arc::ptr_eq(current, entry) => {
                    sessions.remove(key);
                }
                _ => return,
            }
        }
        entry.stop_idle();
        let closing = Arc::clone(entry);
        tokio::spawn(async move { closing.close().await });
    }

    /// Restarts the idle timer of `entry`.
    fn touch(&self, key: &str, entry: &Arc<Entry>) {
        let weak_inner: Weak<Inner> = Arc::downgrade(&self.inner);
        let weak_entry = Arc::downgrade(entry);
        let key = key.to_owned();
        let handle = tokio::spawn(async move {
            tokio::time::sleep(IDLE).await;
            if let (Some(inner), Some(entry)) = (weak_inner.upgrade(), weak_entry.upgrade()) {
                // This task is the timer being cleared; take it out first so it is not aborted.
                entry
                    .idle
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .take();
                Self::close_in(&inner, &key, &entry);
            }
        });
        let previous = entry
            .idle
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .replace(handle);
        if let Some(previous) = previous {
            previous.abort();
        }
    }

    async fn resolve_connection(
        &self,
        request: &DatabaseRequest,
    ) -> CallResult<(DatabaseConnection, Option<VaultTls>)> {
        let Some(item_id) = request.connection.vault_item_id.as_deref() else {
            return Ok((request.connection.clone(), None));
        };
        let cred = self
            .inner
            .vault
            .database_credential(item_id, request.allow_unlock)
            .await
            .map_err(|err| CallError::plain(err.message))?;
        let ssh = cred.database.ssh_host.map(|host| DatabaseSsh {
            host,
            port: cred.database.ssh_port,
            user: cred.database.ssh_user,
            agent: cred.ssh_agent,
        });
        let resolved = DatabaseConnection {
            driver: cred.database.driver,
            host: cred.database.host,
            port: Some(cred.database.port),
            database: cred.database.database,
            username: cred.database.username,
            password: cred.password,
            vault_item_id: None,
            ssh,
        };
        Ok((resolved, Some(cred.database.tls)))
    }

    async fn call(&self, entry: &Entry, request: &DatabaseRequest) -> CallResult<DatabaseResponse> {
        let mut guard = entry.session.lock().await;
        let session = match &mut *guard {
            Some(session) => session,
            empty => {
                let (resolved, tls) = self.resolve_connection(request).await?;
                empty.insert(open_session(&resolved, tls, &self.inner.ssh_binary).await?)
            }
        };
        match &mut session.client {
            Client::Mysql(client) => run_mysql(client, request).await,
            Client::Postgres(client) => run_postgres(client, request).await,
        }
    }

    async fn with_session(&self, request: &DatabaseRequest) -> CallResult<DatabaseResponse> {
        let key = session_key(&request.connection);
        if request.reconnect {
            let stale = self.sessions().get(&key).cloned();
            if let Some(stale) = stale {
                self.close_entry(&key, &stale);
            }
        }
        let mut attempt = 0;
        loop {
            let entry = self.entry(&key);
            self.touch(&key, &entry);
            match self.call(&entry, request).await {
                Ok(response) => {
                    entry.proven.store(true, Ordering::Relaxed);
                    return Ok(response);
                }
                Err(error) => {
                    // The login may be accepted while the connection is wrong; a broken one
                    // cannot be reused.
                    if !entry.proven.load(Ordering::Relaxed) || error.broken {
                        self.close_entry(&key, &entry);
                    }
                    if !error.lost || attempt > 0 {
                        return Err(error);
                    }
                    // The server or network dropped the connection: open a new one, once.
                    self.close_entry(&key, &entry);
                    attempt += 1;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lost_connections_match_conn() {
        for message in [
            "PROTOCOL_CONNECTION_LOST",
            "read ECONNRESET",
            "Connection lost: The server closed the connection.",
            "Can't add new command when connection is in closed state",
            "connection was terminated",
            "Broken pipe (os error 32)",
        ] {
            assert!(lost_text(message), "{message} is a lost connection");
        }
        for message in [
            "Table 'app.x' doesn't exist",
            "Connection refused (os error 61)",
        ] {
            assert!(!lost_text(message), "{message} is not a lost connection");
        }
    }

    #[test]
    fn postgres_tables_default_to_public() {
        assert_eq!(postgres_table("users"), ("public", "users"));
        assert_eq!(postgres_table("audit.events"), ("audit", "events"));
    }

    #[test]
    fn session_keys_change_with_anything_that_reaches_the_database() {
        let base = DatabaseConnection {
            driver: DatabaseDriver::Mysql,
            host: "db".into(),
            port: Some(3306),
            database: "app".into(),
            username: "root".into(),
            password: "a".into(),
            vault_item_id: None,
            ssh: None,
        };
        let changed = DatabaseConnection {
            password: "b".into(),
            ..base.clone()
        };
        assert_ne!(session_key(&base), session_key(&changed));
        let vault = DatabaseConnection {
            vault_item_id: Some("entry-1".into()),
            ..base
        };
        assert_eq!(session_key(&vault), "vault:entry-1");
    }
}
