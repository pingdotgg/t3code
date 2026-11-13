//! Builds and runs the whole server: engine, providers, auth, router. `main.rs` parses the
//! command line; test binaries call [`serve`] with their own providers.

use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use conn_engine::{Engine, EngineConfig, ProjectConfig, SqliteEngine};
use conn_provider::Provider;

use crate::{
    AppState,
    auth::{self, AuthStore},
    environment::Environment,
    method_table,
    methods::Deps,
    router,
};

pub struct ServeOptions {
    pub listen: SocketAddr,
    pub state_dir: PathBuf,
    /// Canonical folders, at least one. The first is the server's `cwd`.
    pub projects: Vec<PathBuf>,
    pub label: Option<String>,
}

const USAGE: &str = "usage: conn-server [--listen <host:port>] [--state-dir <dir>] \
                     [--project <dir>]... [--label <name>]";

impl ServeOptions {
    /// Reads `[--listen <host:port>] [--state-dir <dir>] [--project <dir>]... [--label <name>]`.
    /// Defaults: `127.0.0.1:0` picks a free port; state lives in `$CONN_SERVER_HOME` or
    /// `~/.conn-server`; the project is the current folder.
    pub fn from_args() -> Self {
        let mut args = std::env::args().skip(1);
        let mut listen: SocketAddr = "127.0.0.1:0".parse().expect("valid default address");
        let mut state_dir = std::env::var_os("CONN_SERVER_HOME").map(PathBuf::from);
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
                    std::process::exit(0);
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
        let projects = projects
            .iter()
            .map(|dir| {
                std::fs::canonicalize(dir)
                    .unwrap_or_else(|e| panic!("--project {}: {e}", dir.display()))
            })
            .collect();
        Self {
            listen,
            state_dir,
            projects,
            label,
        }
    }
}

/// Runs until the listener fails. Prints the address, coverage and a pairing URL.
pub async fn serve(options: ServeOptions, providers: Vec<Arc<dyn Provider>>) {
    let ServeOptions {
        listen,
        state_dir,
        projects,
        label,
    } = options;
    let projects: Vec<ProjectConfig> = projects
        .iter()
        .map(|root| ProjectConfig {
            title: root
                .file_name()
                .map_or_else(|| "project".into(), |n| n.to_string_lossy().into_owned()),
            workspace_root: root.to_string_lossy().into_owned(),
        })
        .collect();
    let cwd = PathBuf::from(&projects[0].workspace_root);
    let environment = Arc::new(Environment::load(&state_dir, label, cwd).expect("state directory"));
    let auth = AuthStore::open(state_dir.join("sessions.json")).expect("sessions file");

    let mut config = EngineConfig::new(state_dir.join("engine.sqlite"));
    config.projects = projects;
    config.providers = providers.clone();
    let engine: Arc<dyn Engine> = Arc::new(SqliteEngine::open(config).expect("engine"));
    let deps = Deps {
        engine: Some(engine.clone()),
        providers,
        environment: Some(environment.clone()),
        ..Deps::default()
    };
    let state = AppState {
        table: Arc::new(method_table(&deps)),
        auth: auth.clone(),
        descriptor: Arc::new(environment.descriptor.clone()),
        engine: Some(engine),
        deps,
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
}
