use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use conn_engine::{Engine, EngineConfig, ProjectConfig, SqliteEngine};
use conn_provider::Provider;
use conn_provider_claude::{ClaudeConfig, ClaudeProvider};
use conn_server::{
    AppState,
    auth::{self, AuthStore},
    environment::Environment,
    method_table,
    methods::Deps,
    router,
};

const USAGE: &str = "usage: conn-server [--listen <host:port>] [--state-dir <dir>] \
                     [--project <dir>]... [--label <name>]";

/// Defaults: `127.0.0.1:0` picks a free port; state lives in `$CONN_SERVER_HOME` or
/// `~/.conn-server`; the project is the current folder.
fn main() {
    let mut args = std::env::args().skip(1);
    let mut listen: SocketAddr = "127.0.0.1:0".parse().expect("valid default address");
    let mut state_dir: Option<PathBuf> = std::env::var_os("CONN_SERVER_HOME").map(PathBuf::from);
    let mut projects: Vec<PathBuf> = Vec::new();
    let mut label = None;
    while let Some(arg) = args.next() {
        let mut value = || {
            args.next()
                .unwrap_or_else(|| panic!("{arg} needs a value\n{USAGE}"))
        };
        match arg.as_str() {
            "--listen" => listen = value().parse().expect("--listen takes host:port"),
            "--state-dir" => state_dir = Some(value().into()),
            "--project" => projects.push(value().into()),
            "--label" => label = Some(value()),
            "--help" | "-h" => {
                println!("{USAGE}");
                return;
            }
            other => panic!("unknown argument `{other}`\n{USAGE}"),
        }
    }
    let state_dir = state_dir.unwrap_or_else(|| {
        let home = std::env::var_os("HOME").expect("HOME or --state-dir");
        PathBuf::from(home).join(".conn-server")
    });
    if projects.is_empty() {
        projects.push(std::env::current_dir().expect("current folder"));
    }
    let projects: Vec<ProjectConfig> = projects
        .iter()
        .map(|dir| {
            let root = std::fs::canonicalize(dir)
                .unwrap_or_else(|e| panic!("--project {}: {e}", dir.display()));
            ProjectConfig {
                title: root
                    .file_name()
                    .map_or_else(|| "project".into(), |n| n.to_string_lossy().into_owned()),
                workspace_root: root.to_string_lossy().into_owned(),
            }
        })
        .collect();

    let environment = Arc::new(
        Environment::load(&state_dir, label, projects[0].workspace_root.clone().into())
            .expect("state directory"),
    );
    let auth = AuthStore::open(state_dir.join("sessions.json")).expect("sessions file");
    let providers: Vec<Arc<dyn Provider>> = vec![Arc::new(ClaudeProvider::new(
        "claudeAgent".into(),
        ClaudeConfig::default(),
    ))];

    // One thread: a container serves a handful of clients, and each worker thread costs
    // stack and allocator arenas.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    runtime.block_on(async move {
        let mut config = EngineConfig::new(state_dir.join("engine.sqlite"));
        config.projects = projects;
        config.providers = providers.clone();
        let engine: Arc<dyn Engine> = Arc::new(SqliteEngine::open(config).expect("engine"));
        let deps = Deps {
            engine: Some(engine),
            providers,
            environment: Some(environment.clone()),
        };
        let state = AppState {
            table: Arc::new(method_table(&deps)),
            auth: auth.clone(),
            descriptor: Arc::new(environment.descriptor.clone()),
            engine: deps.engine.clone(),
        };

        let listener = tokio::net::TcpListener::bind(listen).await.expect("bind");
        let addr = listener.local_addr().expect("local addr");
        let pairing = auth.issue_pairing_code(None, auth::STARTUP_PAIRING_CODE_TTL_MS);
        println!("conn-server listening on http://{addr}");
        println!(
            "environment: {} ({})",
            environment.environment_id(),
            state_dir.display()
        );
        println!("methods: {}", state.table.coverage());
        // One code, valid 24 hours, spent by the first device that pairs.
        println!("pairingUrl: http://{addr}/pair#token={}", pairing.code);
        axum::serve(listener, router(state)).await.expect("serve");
    });
}
