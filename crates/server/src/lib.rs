#![warn(clippy::all, clippy::pedantic)]

pub mod config;
pub mod http;
pub mod persistence;
pub mod ws;

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::sync::{broadcast, oneshot, RwLock};
use tracing::error;

use t3code_contracts::orchestration::{OrchestrationEvent, OrchestrationReadModel};
use t3code_contracts::server::{
    ServerConfig, ServerConfigSettingsUpdatedPayload, ServerConfigStreamEvent,
    ServerLifecycleReadyPayload, ServerLifecycleStreamEvent, ServerLifecycleWelcomePayload,
    ServerObservability, ServerSettings,
};

use crate::config::ServerRuntimeConfig;
use crate::http::load_asset_response;
use crate::persistence::SqliteDb;
use crate::ws::handle_socket;

const SQLITE_UTC_TIMESTAMP_FORMAT: &str = "%Y-%m-%dT%H:%M:%fZ";

#[derive(Clone)]
pub struct AppState {
    inner: Arc<AppStateInner>,
}

struct AppStateInner {
    config: ServerRuntimeConfig,
    db: SqliteDb,
    settings: RwLock<ServerSettings>,
    snapshot: RwLock<OrchestrationReadModel>,
    config_events: broadcast::Sender<ServerConfigStreamEvent>,
    orchestration_events: broadcast::Sender<OrchestrationEvent>,
    terminal_events: broadcast::Sender<Value>,
    started_at: String,
}

impl AppState {
    /// Constructs a new server state, running migrations and loading the read-model snapshot.
    ///
    /// # Errors
    ///
    /// Returns an error if the `SQLite` database cannot be opened, migrations fail, or the
    /// persisted snapshot cannot be decoded.
    pub fn new(config: ServerRuntimeConfig) -> anyhow::Result<Self> {
        let (config_events, _) = broadcast::channel(64);
        let (orchestration_events, _) = broadcast::channel(64);
        let (terminal_events, _) = broadcast::channel(64);

        let db = SqliteDb::open_and_migrate(&config.db_path).context("failed to open sqlite db")?;
        let started_at = db
            .with_conn_blocking(current_utc_timestamp)
            .context("failed to compute startup timestamp")?;
        let snapshot = db
            .with_conn_blocking(|conn| load_snapshot_from_db(conn, &started_at))
            .context("failed to load snapshot from sqlite")?;

        Ok(Self {
            inner: Arc::new(AppStateInner {
                config,
                db,
                settings: RwLock::new(ServerSettings::default()),
                snapshot: RwLock::new(snapshot),
                config_events,
                orchestration_events,
                terminal_events,
                started_at,
            }),
        })
    }

    pub async fn server_config(&self) -> ServerConfig {
        let settings = self.settings().await;
        ServerConfig {
            cwd: self.inner.config.cwd.display().to_string(),
            keybindings_config_path: self
                .inner
                .config
                .cwd
                .join("KEYBINDINGS.md")
                .display()
                .to_string(),
            keybindings: Vec::new(),
            issues: Vec::new(),
            providers: Vec::new(),
            available_editors: Vec::new(),
            observability: ServerObservability {
                logs_directory_path: self.inner.config.logs_dir.display().to_string(),
                local_tracing_enabled: true,
                otlp_traces_url: None,
                otlp_traces_enabled: false,
                otlp_metrics_url: None,
                otlp_metrics_enabled: false,
            },
            settings,
        }
    }

    pub async fn settings(&self) -> ServerSettings {
        self.inner.settings.read().await.clone()
    }

    /// Applies a partial settings patch and broadcasts the updated settings snapshot.
    ///
    /// # Errors
    ///
    /// Returns an error if the current settings cannot be serialized or if the merged payload
    /// cannot be deserialized back into [`ServerSettings`].
    pub async fn update_settings(&self, patch: Value) -> anyhow::Result<ServerSettings> {
        let mut current = serde_json::to_value(self.inner.settings.read().await.clone())
            .context("failed to serialize current settings")?;
        merge_json(&mut current, patch);
        let next: ServerSettings =
            serde_json::from_value(current).context("failed to deserialize patched settings")?;
        *self.inner.settings.write().await = next.clone();

        let _ = self
            .inner
            .config_events
            .send(ServerConfigStreamEvent::SettingsUpdated {
                version: 1,
                payload: ServerConfigSettingsUpdatedPayload {
                    settings: next.clone(),
                },
            });

        Ok(next)
    }

    pub async fn snapshot(&self) -> OrchestrationReadModel {
        self.inner.snapshot.read().await.clone()
    }

    /// Loads orchestration events from the persisted event store.
    ///
    /// # Errors
    ///
    /// Returns an error if the database query fails or if stored JSON payloads are invalid.
    pub async fn replay_events(
        &self,
        from_sequence_exclusive: u64,
    ) -> anyhow::Result<Vec<OrchestrationEvent>> {
        self.inner
            .db
            .with_conn(move |conn| {
                use anyhow::Context;

                let mut stmt = conn
                    .prepare(
                        "SELECT sequence, event_id, aggregate_kind, stream_id, occurred_at, command_id, causation_event_id, correlation_id, metadata_json, event_type, payload_json
                         FROM orchestration_events
                         WHERE sequence > ?1
                         ORDER BY sequence ASC",
                    )
                    .context("prepare orchestration_events replay query failed")?;

                let mut rows = stmt
                    .query(rusqlite::params![i64::try_from(from_sequence_exclusive).unwrap_or(i64::MAX)])
                    .context("query orchestration_events replay failed")?;

                let mut out = Vec::new();
                while let Some(row) = rows.next().context("advance orchestration_events rows failed")? {
                    let metadata_json: String = row.get(8)?;
                    let payload_json: String = row.get(10)?;
                    let metadata: serde_json::Value =
                        serde_json::from_str(&metadata_json).context("invalid event metadata_json")?;
                    let payload: serde_json::Value =
                        serde_json::from_str(&payload_json).context("invalid event payload_json")?;

                    out.push(OrchestrationEvent {
                        sequence: row.get::<_, i64>(0).unwrap_or(0).try_into().unwrap_or(0),
                        event_id: row.get(1)?,
                        aggregate_kind: row.get(2)?,
                        aggregate_id: row.get(3)?,
                        occurred_at: row.get(4)?,
                        command_id: row.get(5)?,
                        causation_event_id: row.get(6)?,
                        correlation_id: row.get(7)?,
                        metadata,
                        r#type: row.get(9)?,
                        payload,
                    });
                }

                Ok(out)
            })
            .await
    }

    #[must_use]
    pub fn welcome_event(&self) -> ServerLifecycleStreamEvent {
        let project_name = self.inner.config.cwd.file_name().map_or_else(
            || "workspace".to_owned(),
            |name| name.to_string_lossy().to_string(),
        );

        ServerLifecycleStreamEvent::Welcome {
            version: 1,
            sequence: 1,
            payload: ServerLifecycleWelcomePayload {
                cwd: self.inner.config.cwd.display().to_string(),
                project_name,
                bootstrap_project_id: None,
                bootstrap_thread_id: None,
            },
        }
    }

    #[must_use]
    pub fn ready_event(&self) -> ServerLifecycleStreamEvent {
        ServerLifecycleStreamEvent::Ready {
            version: 1,
            sequence: 2,
            payload: ServerLifecycleReadyPayload {
                at: self.inner.started_at.clone(),
            },
        }
    }

    #[must_use]
    pub fn subscribe_config(&self) -> broadcast::Receiver<ServerConfigStreamEvent> {
        self.inner.config_events.subscribe()
    }

    #[must_use]
    pub fn subscribe_orchestration_events(&self) -> broadcast::Receiver<OrchestrationEvent> {
        self.inner.orchestration_events.subscribe()
    }

    #[must_use]
    pub fn subscribe_terminal_events(&self) -> broadcast::Receiver<Value> {
        self.inner.terminal_events.subscribe()
    }
}

fn load_snapshot_from_db(
    conn: &rusqlite::Connection,
    now: &str,
) -> anyhow::Result<OrchestrationReadModel> {
    use anyhow::Context;
    use rusqlite::OptionalExtension;

    let snapshot_sequence: u64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .context("failed to query orchestration_events max sequence")?
        .unwrap_or(0)
        .try_into()
        .unwrap_or(0);

    let projects = load_projects_from_db(conn)?;
    let threads = load_threads_from_db(conn)?;

    Ok(OrchestrationReadModel {
        snapshot_sequence,
        projects,
        threads,
        updated_at: now.to_owned(),
    })
}

fn load_projects_from_db(
    conn: &rusqlite::Connection,
) -> anyhow::Result<Vec<t3code_contracts::orchestration::OrchestrationProject>> {
    use anyhow::Context;
    use t3code_contracts::orchestration::{ModelSelection, OrchestrationProject, ProjectScript};

    let mut stmt = conn
        .prepare(
            "SELECT project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at, deleted_at
             FROM projection_projects
             WHERE deleted_at IS NULL
             ORDER BY updated_at DESC",
        )
        .context("prepare projection_projects query failed")?;
    let mut rows = stmt.query([]).context("query projection_projects failed")?;
    let mut projects = Vec::new();

    while let Some(row) = rows
        .next()
        .context("advance projection_projects rows failed")?
    {
        let scripts_json: String = row.get(4)?;
        let scripts: Vec<ProjectScript> = serde_json::from_str(&scripts_json)
            .context("invalid projection_projects.scripts_json")?;
        let default_model_selection_json: Option<String> = row.get(3)?;
        let default_model_selection = if let Some(raw) = default_model_selection_json {
            Some(
                serde_json::from_str::<ModelSelection>(&raw)
                    .context("invalid projection_projects.default_model_selection_json")?,
            )
        } else {
            None
        };

        projects.push(OrchestrationProject {
            id: row.get(0)?,
            title: row.get(1)?,
            workspace_root: row.get(2)?,
            default_model_selection,
            scripts,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
            deleted_at: row.get(7)?,
        });
    }

    Ok(projects)
}

fn load_threads_from_db(
    conn: &rusqlite::Connection,
) -> anyhow::Result<Vec<t3code_contracts::orchestration::OrchestrationThread>> {
    use anyhow::Context;
    use t3code_contracts::orchestration::{ModelSelection, OrchestrationThread, ProviderKind};

    let mut stmt = conn
        .prepare(
            "SELECT thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, branch, worktree_path, latest_turn_id, created_at, updated_at, archived_at, deleted_at
             FROM projection_threads
             WHERE deleted_at IS NULL
             ORDER BY updated_at DESC",
        )
        .context("prepare projection_threads query failed")?;
    let mut rows = stmt.query([]).context("query projection_threads failed")?;
    let mut threads = Vec::new();

    while let Some(row) = rows
        .next()
        .context("advance projection_threads rows failed")?
    {
        let model_selection_json: Option<String> = row.get(3)?;
        let model_selection = if let Some(raw) = model_selection_json {
            serde_json::from_str::<ModelSelection>(&raw)
                .context("invalid projection_threads.model_selection_json")?
        } else {
            ModelSelection {
                provider: ProviderKind::Codex,
                model: "gpt-5.4".to_owned(),
                options: None,
            }
        };

        threads.push(OrchestrationThread {
            id: row.get(0)?,
            project_id: row.get(1)?,
            title: row.get(2)?,
            model_selection,
            runtime_mode: row.get(4)?,
            interaction_mode: row.get(5)?,
            branch: row.get(6)?,
            worktree_path: row.get(7)?,
            latest_turn: None,
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
            archived_at: row.get(11)?,
            deleted_at: row.get(12)?,
            messages: Vec::new(),
            proposed_plans: Vec::new(),
            activities: Vec::new(),
            checkpoints: Vec::new(),
            session: None,
        });
    }

    Ok(threads)
}

fn current_utc_timestamp(conn: &rusqlite::Connection) -> anyhow::Result<String> {
    use anyhow::Context;

    conn.query_row(
        "SELECT strftime(?1, 'now')",
        rusqlite::params![SQLITE_UTC_TIMESTAMP_FORMAT],
        |row| row.get::<_, String>(0),
    )
    .context("failed to query sqlite utc timestamp")
}

pub struct ServerHandle {
    pub local_addr: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
    join_handle: tokio::task::JoinHandle<anyhow::Result<()>>,
}

impl ServerHandle {
    /// Requests server shutdown and waits for the Axum task to finish.
    ///
    /// # Errors
    ///
    /// Returns an error if the server task cannot be joined or if the server exits with an
    /// internal error during shutdown.
    pub async fn shutdown(mut self) -> anyhow::Result<()> {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }

        self.join_handle
            .await
            .context("server task join failed")?
            .context("server exited with error")
    }
}

/// Starts the embedded Axum server on the provided listener and returns a shutdown handle.
///
/// # Errors
///
/// Returns an error if the listener address cannot be queried before the server task is spawned.
pub fn spawn(
    listener: TcpListener,
    runtime_config: ServerRuntimeConfig,
) -> anyhow::Result<ServerHandle> {
    let local_addr = listener
        .local_addr()
        .context("failed to read listener address")?;
    let state = AppState::new(runtime_config)?;
    let router = make_router(state.clone());
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    let server = async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .context("axum server failed")
    };

    let join_handle = tokio::spawn(server);

    Ok(ServerHandle {
        local_addr,
        shutdown: Some(shutdown_tx),
        join_handle,
    })
}

pub fn make_router(state: AppState) -> Router {
    Router::new()
        .route("/ws", get(ws_route))
        .route("/", get(root_asset))
        .route("/{*path}", get(named_asset))
        .with_state(state)
}

async fn ws_route(
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if query.token.as_deref() != Some(state.inner.config.ws_token.as_str()) {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }

    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn root_asset(State(state): State<AppState>) -> Response {
    asset_response(state, String::new(), None).await
}

async fn named_asset(State(state): State<AppState>, Path(path): Path<String>) -> Response {
    asset_response(state, path, None).await
}

/// Loads an asset for the custom `t3://` protocol.
///
/// # Errors
///
/// Returns an error if the asset path is invalid, if the file cannot be read, or if bridge
/// script injection fails while preparing HTML output.
pub async fn load_protocol_asset(
    state: &AppState,
    path: &str,
    injected_head_script: Option<&str>,
) -> anyhow::Result<(Vec<u8>, &'static str)> {
    let asset =
        load_asset_response(&state.inner.config.web_dist_dir, path, injected_head_script).await?;
    Ok((asset.body, asset.content_type))
}

async fn asset_response(
    state: AppState,
    path: String,
    injected_head_script: Option<&str>,
) -> Response {
    match load_protocol_asset(&state, &path, injected_head_script).await {
        Ok((body, content_type)) => {
            let mut headers = HeaderMap::new();
            headers.insert(
                axum::http::header::CONTENT_TYPE,
                HeaderValue::from_static(content_type),
            );
            (headers, body).into_response()
        }
        Err(error) => {
            error!(?error, "failed to serve asset");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Unable to serve frontend asset: {error}"),
            )
                .into_response()
        }
    }
}

#[derive(Debug, serde::Deserialize)]
struct WsQuery {
    token: Option<String>,
}

fn merge_json(current: &mut Value, patch: Value) {
    match (current, patch) {
        (Value::Object(current_map), Value::Object(patch_map)) => {
            for (key, value) in patch_map {
                if let Some(current_value) = current_map.get_mut(&key) {
                    merge_json(current_value, value);
                } else {
                    current_map.insert(key, value);
                }
            }
        }
        (current_value, next_value) => {
            *current_value = next_value;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use t3code_contracts::server::ServerLifecycleStreamEvent;

    use super::{AppState, ServerRuntimeConfig};

    #[tokio::test]
    async fn exposes_empty_bootstrap_state() {
        let state = AppState::new(test_config()).expect("state should init");

        let config = state.server_config().await;
        assert!(config.providers.is_empty());
        assert!(config.keybindings.is_empty());

        let snapshot = state.snapshot().await;
        assert_eq!(snapshot.snapshot_sequence, 0);
        assert!(snapshot.projects.is_empty());
        assert!(snapshot.threads.is_empty());
    }

    #[tokio::test]
    async fn updates_settings_in_memory() {
        let state = AppState::new(test_config()).expect("state should init");
        let next = state
            .update_settings(serde_json::json!({
                "enableAssistantStreaming": true,
                "providers": {
                    "codex": {
                        "homePath": "/tmp/codex-home"
                    }
                }
            }))
            .await
            .expect("settings should update");

        assert!(next.enable_assistant_streaming);
        assert_eq!(next.providers.codex.home_path, "/tmp/codex-home");
    }

    #[tokio::test]
    async fn ready_event_uses_runtime_timestamp() {
        let state = AppState::new(test_config()).expect("state should init");
        let ready = state.ready_event();

        match ready {
            ServerLifecycleStreamEvent::Ready { payload, .. } => {
                assert_ne!(payload.at, "2026-04-07T00:00:00Z");
                assert!(payload.at.ends_with('Z'));
                assert!(payload.at.contains('T'));
            }
            _ => panic!("expected ready event"),
        }
    }

    fn test_config() -> ServerRuntimeConfig {
        let temp_dir = temp_dir();
        std::fs::create_dir_all(&temp_dir).expect("temp dir");
        std::fs::write(temp_dir.join("index.html"), "<html></html>").expect("write index");

        let db_path = temp_dir.join("state.sqlite3");
        ServerRuntimeConfig {
            cwd: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            web_dist_dir: temp_dir,
            ws_token: "secret-token".to_owned(),
            logs_dir: PathBuf::from("/tmp/t3-logs"),
            db_path,
        }
    }

    fn temp_dir() -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("t3code-rust-server-{}", uuid::Uuid::new_v4()));
        path
    }
}
