//! The runner against a real SQLite file, and (ignored unless a server is given) live MySQL and
//! PostgreSQL servers.
#![expect(
    clippy::panic_in_result_fn,
    reason = "tests assert and use ? for setup"
)]

use serde_json::{Value, json};

use super::*;

type TestResult = Result<(), Box<dyn std::error::Error>>;

async fn sqlite_db(dir: &tempfile::TempDir) -> Result<DatabaseConnection, sqlx::Error> {
    use sqlx::{ConnectOptions as _, Connection as _, Executor as _};
    let file = dir.path().join("app.sqlite");
    // Seeded with a writable connection before the runner opens the file read-only.
    let mut seed = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&file)
        .create_if_missing(true)
        .connect()
        .await?;
    seed.execute(
        "create table users (id integer primary key, name text not null, born text default 'now', avatar blob, score real);
         insert into users (name, avatar, score) values ('ada', x'cafe', 1.5), ('grace', null, null);
         create view names as select name from users;
         create table many (n integer);
         with recursive c(n) as (select 1 union all select n + 1 from c where n < 600) insert into many select n from c;",
    )
    .await?;
    seed.close().await?;
    Ok(DatabaseConnection {
        driver: DatabaseDriver::Sqlite,
        host: String::new(),
        port: None,
        database: file.to_string_lossy().into_owned(),
        username: String::new(),
        password: String::new(),
        vault_item_id: None,
        ssh: None,
    })
}

fn row(pairs: &[(&str, Value)]) -> DatabaseRow {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect()
}

#[tokio::test]
async fn sqlite_lists_tables_describes_columns_and_runs_a_select() -> TestResult {
    let dir = tempfile::tempdir()?;
    let connection = sqlite_db(&dir).await?;
    let runner = DatabaseRunner::new();

    let tables = runner
        .run(&DatabaseRequest::tables(connection.clone()))
        .await;
    assert_eq!(tables.error, None);
    assert_eq!(tables.tables, ["many", "names", "users"]);

    let described = runner
        .run(&DatabaseRequest::describe(connection.clone(), "users"))
        .await;
    let summary: Vec<_> = described
        .columns
        .iter()
        .map(|column| (column.name.as_str(), column.primary, column.nullable))
        .collect();
    assert_eq!(
        summary,
        [
            ("id", true, true),
            ("name", false, false),
            ("born", false, true),
            ("avatar", false, true),
            ("score", false, true),
        ]
    );
    assert_eq!(described.columns[2].default_value.as_deref(), Some("'now'"));
    assert_eq!(described.columns[0].data_type, "INTEGER");

    let query = runner
        .run(&DatabaseRequest::query(
            connection.clone(),
            "-- newest first\nselect id, name, avatar, score from users order by id desc",
        ))
        .await;
    assert_eq!(query.error, None);
    assert_eq!(query.result_columns, ["id", "name", "avatar", "score"]);
    assert_eq!(
        query.rows,
        [
            row(&[
                ("id", json!(2)),
                ("name", json!("grace")),
                ("avatar", Value::Null),
                ("score", Value::Null)
            ]),
            row(&[
                ("id", json!(1)),
                ("name", json!("ada")),
                ("avatar", json!("0xcafe")),
                ("score", json!(1.5))
            ]),
        ]
    );
    assert_eq!(query.row_count, 2);
    assert!(!query.truncated, "two rows fit");
    assert!(query.duration_ms >= 0.0, "duration is measured");
    Ok(())
}

#[tokio::test]
async fn sqlite_keeps_the_first_500_rows() -> TestResult {
    let dir = tempfile::tempdir()?;
    let connection = sqlite_db(&dir).await?;
    let result = DatabaseRunner::new()
        .run(&DatabaseRequest::query(
            connection,
            "select n from many order by n",
        ))
        .await;
    assert_eq!(result.error, None);
    assert_eq!(result.rows.len(), ROW_LIMIT);
    assert_eq!(result.row_count, 600);
    assert!(result.truncated, "600 rows are more than the panel keeps");
    assert_eq!(result.rows[ROW_LIMIT - 1], row(&[("n", json!(500))]));
    Ok(())
}

#[tokio::test]
async fn sqlite_reports_columns_of_an_empty_result() -> TestResult {
    let dir = tempfile::tempdir()?;
    let connection = sqlite_db(&dir).await?;
    let result = DatabaseRunner::new()
        .run(&DatabaseRequest::query(
            connection,
            "select id, name from users where 0",
        ))
        .await;
    assert_eq!(result.error, None);
    assert_eq!(result.result_columns, ["id", "name"]);
    assert!(result.rows.is_empty(), "no rows");
    Ok(())
}

async fn user_count(runner: &DatabaseRunner, connection: &DatabaseConnection) -> Vec<DatabaseRow> {
    runner
        .run(&DatabaseRequest::query(
            connection.clone(),
            "select count(*) as n from users",
        ))
        .await
        .rows
}

#[tokio::test]
async fn sqlite_refuses_statements_that_change_data_or_schema() -> TestResult {
    let dir = tempfile::tempdir()?;
    let connection = sqlite_db(&dir).await?;
    let runner = DatabaseRunner::new();
    for sql in [
        "delete from users",
        "drop table users",
        "/* x */ update users set name = ''",
    ] {
        let result = runner
            .run(&DatabaseRequest::query(connection.clone(), sql))
            .await;
        assert!(
            result
                .error
                .as_deref()
                .is_some_and(|error| error.contains("read-only")),
            "{sql}: {:?}",
            result.error
        );
    }
    // A write hidden behind a reading keyword still fails: the file is opened read-only.
    let hidden = runner
        .run(&DatabaseRequest::query(
            connection.clone(),
            "with x as (select 1) insert into users (name) select 'eve' from x",
        ))
        .await;
    assert!(hidden.error.is_some(), "the hidden write fails");
    assert_eq!(
        user_count(&runner, &connection).await,
        [row(&[("n", json!(2))])]
    );
    Ok(())
}

#[tokio::test]
async fn sqlite_runs_only_the_first_of_stacked_statements() -> TestResult {
    let dir = tempfile::tempdir()?;
    let connection = sqlite_db(&dir).await?;
    let runner = DatabaseRunner::new();
    let stacked = runner
        .run(&DatabaseRequest::query(
            connection.clone(),
            "select 1 as one; delete from users",
        ))
        .await;
    assert_eq!(stacked.error, None);
    assert_eq!(stacked.rows, [row(&[("one", json!(1))])]);
    assert_eq!(
        user_count(&runner, &connection).await,
        [row(&[("n", json!(2))])]
    );
    Ok(())
}

#[tokio::test]
async fn sqlite_reports_a_missing_file_and_bad_sql() -> TestResult {
    let dir = tempfile::tempdir()?;
    let mut connection = sqlite_db(&dir).await?;
    let runner = DatabaseRunner::new();
    let bad = runner
        .run(&DatabaseRequest::query(
            connection.clone(),
            "select nope from users",
        ))
        .await;
    assert!(
        bad.error
            .as_deref()
            .is_some_and(|error| error.contains("no such column")),
        "{:?}",
        bad.error
    );
    connection.database = dir
        .path()
        .join("missing.sqlite")
        .to_string_lossy()
        .into_owned();
    let missing = runner.run(&DatabaseRequest::tables(connection)).await;
    assert!(missing.error.is_some(), "a missing file is not created");
    assert!(
        !dir.path().join("missing.sqlite").exists(),
        "read-only never creates"
    );
    Ok(())
}

#[tokio::test]
async fn vault_connections_report_missing_or_locked_vault() {
    let connection = DatabaseConnection {
        driver: DatabaseDriver::Mysql,
        host: "db.test".into(),
        port: None,
        database: "app".into(),
        username: String::new(),
        password: String::new(),
        vault_item_id: Some("entry-1".into()),
        ssh: None,
    };
    let result = DatabaseRunner::with_vault_binary("/nonexistent/Vault")
        .run(&DatabaseRequest::tables(connection))
        .await;
    assert_eq!(
        result.error.as_deref(),
        Some("Vault is not installed on this Mac.")
    );
}

#[tokio::test]
async fn refusal_comes_before_connecting() {
    // An unreachable server is never contacted for a write.
    let connection = DatabaseConnection {
        driver: DatabaseDriver::Pgsql,
        host: "127.0.0.1".into(),
        port: Some(1),
        database: "app".into(),
        username: "u".into(),
        password: String::new(),
        vault_item_id: None,
        ssh: None,
    };
    let runner = DatabaseRunner::new();
    let result = runner
        .run(&DatabaseRequest::query(connection, "delete from users"))
        .await;
    assert_eq!(
        result.error.as_deref(),
        Some(
            "The Database panel is read-only. Run select, with, show, describe or explain statements."
        )
    );
    assert_eq!(runner.open_connections(), 0);
}

#[tokio::test]
async fn an_unreachable_server_is_reported_and_not_kept() {
    let connection = DatabaseConnection {
        driver: DatabaseDriver::Mysql,
        host: "127.0.0.1".into(),
        port: Some(1),
        database: "app".into(),
        username: "root".into(),
        password: String::new(),
        vault_item_id: None,
        ssh: None,
    };
    let runner = DatabaseRunner::new();
    let result = runner
        .run(&DatabaseRequest::tables(connection.clone()))
        .await;
    assert!(result.error.is_some(), "port 1 refuses");
    assert_eq!(runner.open_connections(), 0);
    let message = api::list_database_tables(&runner, &connection, api::CallOptions::default())
        .await
        .err()
        .map(|error| error.0)
        .unwrap_or_default();
    assert!(message.ends_with("a host this Mac can reach."), "{message}");
}

/// A server from `CONN_DESKTOP_TEST_<NAME>`: a `DatabaseConnection` as JSON, for example
/// `{"driver":"mysql","host":"127.0.0.1","port":3306,"database":"test","username":"root","password":""}`.
/// The user needs `create` rights on that database.
fn live(name: &str) -> Option<DatabaseConnection> {
    let raw = std::env::var(format!("CONN_DESKTOP_TEST_{name}")).ok()?;
    serde_json::from_str(&raw).ok()
}

async fn live_round_trip(connection: DatabaseConnection) -> TestResult {
    let runner = DatabaseRunner::new();
    let tables = runner
        .run(&DatabaseRequest::tables(connection.clone()))
        .await;
    assert_eq!(tables.error, None);
    let query = runner
        .run(&DatabaseRequest::query(
            connection.clone(),
            "select 1 as one",
        ))
        .await;
    assert_eq!(query.error, None);
    assert_eq!(query.rows, [row(&[("one", json!(1))])]);
    // One statement only, and the session is read-only.
    let stacked = runner
        .run(&DatabaseRequest::query(
            connection.clone(),
            "select 1; create table conn_gpui_probe (id int)",
        ))
        .await;
    assert!(stacked.error.is_some(), "stacked statements fail");
    let hidden = runner
        .run(&DatabaseRequest::query(
            connection.clone(),
            "with x as (select 1) select * from x for update",
        ))
        .await;
    let _ = hidden; // `for update` is allowed by some servers in read-only mode
    assert_eq!(runner.open_connections(), 1, "one kept connection");
    let again = runner
        .run(&DatabaseRequest::query(connection, "select 2 as two").reconnecting(true))
        .await;
    assert_eq!(again.error, None);
    runner.close_all().await;
    assert_eq!(runner.open_connections(), 0);
    Ok(())
}

/// Run with `CONN_DESKTOP_TEST_MYSQL='{"driver":"mysql",...}' cargo test -p conn-desktop -- --ignored`.
#[tokio::test]
#[ignore = "needs a MySQL server in CONN_DESKTOP_TEST_MYSQL"]
async fn mysql_live() -> TestResult {
    let connection = live("MYSQL").ok_or("set CONN_DESKTOP_TEST_MYSQL")?;
    live_round_trip(connection).await
}

/// Run with `CONN_DESKTOP_TEST_PGSQL='{"driver":"pgsql",...}' cargo test -p conn-desktop -- --ignored`.
#[tokio::test]
#[ignore = "needs a PostgreSQL server in CONN_DESKTOP_TEST_PGSQL"]
async fn postgres_live() -> TestResult {
    let connection = live("PGSQL").ok_or("set CONN_DESKTOP_TEST_PGSQL")?;
    live_round_trip(connection).await
}
