//! Pure persistence and view-model helpers for the Database surface.
//!
//! Kept GPUI-free so every helper and an end-to-end tempfile SQLite flow can be unit-tested
//! without a window server.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use conn_desktop::database::api::{
    DatabaseProjectState, DatabaseQueryResult, PanelConnection, connection_from_env,
    connection_target, default_connection,
};
use conn_desktop::database::{DatabaseColumn, DatabaseDriver};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Maximum pixel width of a result grid column (`max-w-72` = 288px).
pub(crate) const MAX_COLUMN_WIDTH_PX: f32 = 288.0;
/// Minimum pixel width of a result grid column.
pub(crate) const MIN_COLUMN_WIDTH_PX: f32 = 72.0;
/// Approximate width of one monospace character at `12px` (`text-xs`).
const MONO_CHAR_WIDTH_PX: f32 = 7.3;
/// Horizontal padding inside a non-first grid cell (`px-3` = 12px each side).
const CELL_PAD_X_PX: f32 = 24.0;
/// Extra start padding on the first grid column (`first:ps-4` vs `px-3`).
const FIRST_CELL_EXTRA_PAD_PX: f32 = 4.0;
/// Number of rows scanned when estimating column widths.
const WIDTH_SAMPLE_ROWS: usize = 64;

/// Persisted Database panel state across projects (`database.json`), matching Conn's
/// `t3code:database-panel:v1` shape.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DatabaseStore {
    #[serde(default)]
    pub(crate) by_project_key: HashMap<String, DatabaseProjectState>,
}

impl DatabaseStore {
    pub(crate) fn from_persisted_json(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }

    pub(crate) fn to_persisted_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }

    pub(crate) fn project(&self, project_key: &str) -> Option<&DatabaseProjectState> {
        self.by_project_key.get(project_key)
    }

    pub(crate) fn saved_connections(&self, project_key: &str) -> &[PanelConnection] {
        self.project(project_key)
            .map_or(&[], |state| state.connections.as_slice())
    }

    pub(crate) fn remembered_connection(&self, project_key: &str) -> Option<&str> {
        self.project(project_key)
            .and_then(|state| state.connection.as_deref())
    }

    pub(crate) fn sql(&self, project_key: &str, connection_id: &str) -> &str {
        self.project(project_key)
            .map_or("", |state| state.sql(connection_id))
    }

    pub(crate) fn set_connection(&mut self, project_key: &str, id: &str) {
        self.by_project_key
            .entry(project_key.to_owned())
            .or_default()
            .set_connection(id);
    }

    pub(crate) fn save_connection(&mut self, project_key: &str, connection: PanelConnection) {
        self.by_project_key
            .entry(project_key.to_owned())
            .or_default()
            .save_connection(connection);
    }

    pub(crate) fn remove_connection(&mut self, project_key: &str, id: &str) {
        if let Some(project) = self.by_project_key.get_mut(project_key) {
            project.remove_connection(id);
        }
    }

    pub(crate) fn set_sql(&mut self, project_key: &str, connection_id: &str, sql: String) {
        self.by_project_key
            .entry(project_key.to_owned())
            .or_default()
            .set_sql(connection_id, sql);
    }
}

/// Path where saved connections and per-connection SQL live (`database.json`).
pub(crate) fn store_path() -> Option<PathBuf> {
    // Tests never read or write the user's saved connections.
    if cfg!(test) {
        return None;
    }
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join("Library/Application Support/conn-gpui/database.json"))
}

/// Loads persisted Database panel state from disk, falling back to an empty store.
pub(crate) fn load_store() -> DatabaseStore {
    store_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|json| DatabaseStore::from_persisted_json(&json).ok())
        .unwrap_or_default()
}

/// Writes `store` to disk, creating parent directories if needed.
pub(crate) fn save_store(store: &DatabaseStore) {
    let (Some(path), Ok(json)) = (store_path(), store.to_persisted_json()) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(error) = std::fs::write(&path, json) {
        eprintln!("database panel: could not save state: {error}");
    }
}

/// Reads `<workspace_root>/.env` and extracts a Laravel-style `DB_*` connection when present.
pub(crate) fn load_env_connection(workspace_root: Option<&str>) -> Option<PanelConnection> {
    let root = workspace_root?;
    let env_path = Path::new(root).join(".env");
    let contents = std::fs::read_to_string(env_path).ok()?;
    connection_from_env(&contents, root)
}

/// Combines the project's `.env` connection (when present) ahead of saved manual connections.
pub(crate) fn project_connections(
    env_connection: Option<&PanelConnection>,
    saved: &[PanelConnection],
) -> Vec<PanelConnection> {
    let mut all = Vec::with_capacity(saved.len() + usize::from(env_connection.is_some()));
    if let Some(env) = env_connection {
        all.push(env.clone());
    }
    all.extend_from_slice(saved);
    all
}

/// Resolves the active connection from the combined list and the remembered connection id.
pub(crate) fn active_connection(
    connections: &[PanelConnection],
    remembered: Option<&str>,
) -> Option<PanelConnection> {
    default_connection(connections, remembered).cloned()
}

/// Case-insensitive substring filter over table names, matching Conn's `TableList`.
pub(crate) fn filter_tables(tables: &[String], filter: &str) -> Vec<String> {
    let needle = filter.trim().to_lowercase();
    if needle.is_empty() {
        return tables.to_vec();
    }
    tables
        .iter()
        .filter(|name| name.to_lowercase().contains(&needle))
        .cloned()
        .collect()
}

/// Parses a port input string like JavaScript's `Number.parseInt(value, 10)` into `Option<u16>`.
pub(crate) fn parse_port_input(raw: &str) -> Option<u16> {
    let trimmed = raw.trim_start();
    let digits: String = trimmed.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<u16>().ok()
}

/// Default port placeholder text for non-SQLite drivers.
pub(crate) const fn default_port_placeholder(driver: DatabaseDriver) -> &'static str {
    match driver {
        DatabaseDriver::Pgsql => "5432",
        DatabaseDriver::Mysql | DatabaseDriver::Sqlite => "3306",
    }
}

/// Placeholder for the Name field (`connectionTarget(draft) || "My database"`).
pub(crate) fn name_placeholder(draft: &PanelConnection) -> String {
    let target = connection_target(&draft.connection, draft.ssh_host.as_deref());
    if target.is_empty() || target == "/" {
        "My database".to_owned()
    } else {
        target
    }
}

/// Normalizes a connection draft before saving: trims the name and falls back to `connectionTarget`.
pub(crate) fn finalize_draft(mut draft: PanelConnection) -> PanelConnection {
    let trimmed = draft.name.trim();
    draft.name = if trimmed.is_empty() {
        connection_target(&draft.connection, draft.ssh_host.as_deref())
    } else {
        trimmed.to_owned()
    };
    draft
}

/// Display representation of one result grid cell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CellDisplay {
    /// SQL `NULL` or missing column value.
    Null,
    /// Single-line string ready for truncated rendering.
    Text(String),
}

/// Formats a JSON cell value for the result grid, collapsing line breaks for single-line truncation.
pub(crate) fn format_cell_value(value: Option<&Value>) -> CellDisplay {
    match value {
        None | Some(Value::Null) => CellDisplay::Null,
        Some(Value::String(text)) => CellDisplay::Text(single_line(text)),
        Some(Value::Bool(flag)) => CellDisplay::Text(if *flag { "true" } else { "false" }.into()),
        Some(Value::Number(num)) => CellDisplay::Text(num.to_string()),
        Some(other) => CellDisplay::Text(single_line(
            &serde_json::to_string(other).unwrap_or_default(),
        )),
    }
}

fn single_line(text: &str) -> String {
    if !text.contains(['\n', '\r']) {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '\r' => {}
            '\n' => out.push(' '),
            other => out.push(other),
        }
    }
    out
}

/// Formats the right-hand type / nullability / default line in `StructureList`.
pub(crate) fn format_column_details(column: &DatabaseColumn) -> String {
    let mut text = column.data_type.clone();
    if column.nullable {
        text.push_str(" · nullable");
    }
    if let Some(default) = &column.default_value {
        text.push_str(" · default ");
        text.push_str(default);
    }
    text
}

/// Formats the trailing summary next to the Run button (`"First 500 rows · 12 ms"` or `"12 ms"`).
pub(crate) fn format_result_summary(result: &DatabaseQueryResult) -> String {
    let ms = result.duration_ms.round() as i64;
    if result.truncated {
        format!("First 500 rows · {ms} ms")
    } else {
        format!("{ms} ms")
    }
}

/// Computes fixed pixel widths for every column in `result` so header and data rows align cleanly.
pub(crate) fn measure_column_widths(result: &DatabaseQueryResult) -> Vec<f32> {
    result
        .columns
        .iter()
        .enumerate()
        .map(|(col_index, column)| {
            let mut max_chars = column.chars().count();
            for row in result.rows.iter().take(WIDTH_SAMPLE_ROWS) {
                let len = match format_cell_value(row.get(column)) {
                    CellDisplay::Null => 4,
                    CellDisplay::Text(text) => text.chars().count(),
                };
                if len > max_chars {
                    max_chars = len;
                }
            }
            let extra_pad = if col_index == 0 {
                FIRST_CELL_EXTRA_PAD_PX
            } else {
                0.0
            };
            let estimated =
                (max_chars as f32) * MONO_CHAR_WIDTH_PX + CELL_PAD_X_PX + extra_pad + 6.0;
            estimated.clamp(MIN_COLUMN_WIDTH_PX, MAX_COLUMN_WIDTH_PX)
        })
        .collect()
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests assert and use ? for setup"
)]
mod tests {
    use conn_desktop::database::DatabaseRunner;
    use conn_desktop::database::api::{
        CallOptions, ConnectionSource, browse_table_sql, describe_database_table,
        list_database_tables, new_connection, run_read_only_query,
    };
    use serde_json::json;

    use super::*;

    #[test]
    fn store_persists_connections_and_sql_per_project() -> Result<(), serde_json::Error> {
        let mut store = DatabaseStore::default();
        let mut conn = new_connection(None);
        conn.name = "Local MySQL".into();
        conn.connection.database = "shop".into();
        let id = conn.id.clone();

        store.save_connection("proj-1", conn);
        store.set_sql("proj-1", &id, "select 1".into());

        let json = store.to_persisted_json()?;
        let reloaded = DatabaseStore::from_persisted_json(&json)?;
        assert_eq!(reloaded, store, "store round-trips through JSON");
        assert_eq!(
            reloaded.sql("proj-1", &id),
            "select 1",
            "SQL is restored per connection"
        );
        assert_eq!(
            reloaded.remembered_connection("proj-1"),
            Some(id.as_str()),
            "saved connection becomes remembered"
        );
        Ok(())
    }

    #[test]
    fn filter_tables_matches_case_insensitively() {
        let tables = vec![
            "users".into(),
            "user_sessions".into(),
            "Orders".into(),
            "migrations".into(),
        ];
        assert_eq!(
            filter_tables(&tables, "  USER "),
            vec!["users".to_owned(), "user_sessions".to_owned()],
            "trimmed case-insensitive substring match"
        );
        assert_eq!(
            filter_tables(&tables, ""),
            tables,
            "empty filter returns all tables"
        );
        assert!(
            filter_tables(&tables, "missing").is_empty(),
            "non-matching filter returns empty list"
        );
    }

    #[test]
    fn port_parsing_and_draft_finalization_match_conn() {
        assert_eq!(parse_port_input("5432"), Some(5432), "valid port");
        assert_eq!(parse_port_input(" 3306abc"), Some(3306), "parseInt prefix");
        assert_eq!(parse_port_input(""), None, "empty port");
        assert_eq!(parse_port_input("999999"), None, "overflow port");

        let mut draft = new_connection(None);
        draft.connection.host = "127.0.0.1".into();
        draft.connection.port = Some(5432);
        draft.connection.database = "app".into();
        draft.name = "   ".into();
        let finalized = finalize_draft(draft);
        assert_eq!(
            finalized.name, "127.0.0.1:5432/app",
            "blank name falls back to connection target"
        );
    }

    #[test]
    fn cell_column_and_summary_formatting_match_conn() {
        assert_eq!(
            format_cell_value(None),
            CellDisplay::Null,
            "missing cell renders NULL"
        );
        assert_eq!(
            format_cell_value(Some(&Value::Null)),
            CellDisplay::Null,
            "null JSON renders NULL"
        );
        assert_eq!(
            format_cell_value(Some(&json!("line1\nline2"))),
            CellDisplay::Text("line1 line2".into()),
            "newlines collapse for single-line truncation"
        );
        assert_eq!(
            format_cell_value(Some(&json!(true))),
            CellDisplay::Text("true".into()),
            "booleans format cleanly"
        );

        let column = DatabaseColumn {
            name: "email".into(),
            data_type: "varchar(255)".into(),
            nullable: true,
            default_value: Some("''".into()),
            primary: false,
        };
        assert_eq!(
            format_column_details(&column),
            "varchar(255) · nullable · default ''",
            "structure details match Conn wording"
        );

        let result = DatabaseQueryResult {
            columns: vec!["id".into()],
            rows: vec![],
            row_count: 500,
            truncated: true,
            duration_ms: 14.6,
        };
        assert_eq!(
            format_result_summary(&result),
            "First 500 rows · 15 ms",
            "truncated summary rounds duration"
        );
        let short = DatabaseQueryResult {
            truncated: false,
            duration_ms: 3.2,
            ..result
        };
        assert_eq!(
            format_result_summary(&short),
            "3 ms",
            "non-truncated summary shows duration only"
        );
    }

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(label: &str) -> std::io::Result<Self> {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            let path = std::env::temp_dir().join(format!(
                "conn-gpui-db-{label}-{}-{nanos}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path)?;
            Ok(Self(path))
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn sqlite_tempfile_loads_tables_columns_and_rows() -> Result<(), Box<dyn std::error::Error>> {
        let dir = TestDir::new("sqlite")?;
        let db_path = dir.path().join("app.sqlite");
        let env_path = dir.path().join(".env");
        std::fs::write(&env_path, "DB_CONNECTION=sqlite\nDB_DATABASE=app.sqlite\n")?;

        // Build a real SQLite database using the system `sqlite3` CLI (always present on macOS).
        let status = std::process::Command::new("sqlite3")
            .arg(&db_path)
            .arg(
                "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, bio TEXT);\
                 INSERT INTO users (id, email, bio) VALUES (1, 'nick@example.com', NULL),\
                 (2, 'ada@example.com', 'hello world');",
            )
            .status()?;
        assert!(status.success(), "sqlite3 created test database");

        let root = dir.path().to_string_lossy();
        let env_conn = load_env_connection(Some(&root)).ok_or("expected .env connection")?;
        assert_eq!(
            env_conn.source,
            ConnectionSource::Env,
            "loaded from project .env"
        );
        assert_eq!(
            env_conn.connection.driver,
            DatabaseDriver::Sqlite,
            "driver detected as sqlite"
        );

        let runner = DatabaseRunner::new();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;

        let (tables, columns, query_result) = rt.block_on(async {
            let tables =
                list_database_tables(&runner, &env_conn.connection, CallOptions::default()).await?;
            let columns = describe_database_table(
                &runner,
                &env_conn.connection,
                "users",
                CallOptions::default(),
            )
            .await?;
            let sql = browse_table_sql(env_conn.connection.driver, "users");
            let result =
                run_read_only_query(&runner, &env_conn.connection, &sql, CallOptions::default())
                    .await?;
            Ok::<_, conn_desktop::database::api::DatabaseCallError>((tables, columns, result))
        })?;

        assert_eq!(tables, vec!["users".to_owned()], "lists users table");
        assert_eq!(columns.len(), 3, "describes all 3 columns");
        assert!(columns[0].primary, "id is primary key");
        assert_eq!(query_result.row_count, 2, "returns 2 inserted rows");
        assert_eq!(
            format_cell_value(query_result.rows[0].get("bio")),
            CellDisplay::Null,
            "NULL cell detected"
        );
        let widths = measure_column_widths(&query_result);
        assert_eq!(widths.len(), 3, "computes width for each column");
        assert!(
            widths
                .iter()
                .all(|w| *w >= MIN_COLUMN_WIDTH_PX && *w <= MAX_COLUMN_WIDTH_PX),
            "widths stay within clamped bounds"
        );
        Ok(())
    }
}
