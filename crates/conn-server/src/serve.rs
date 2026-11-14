//! Builds and runs the whole server: engine, providers, auth, router. `main.rs` parses the
//! command line (`cli.rs`); test binaries call [`serve`] with their own providers.

use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, OnceLock},
    time::Duration,
};

use conn_engine::{Engine, EngineConfig, ProjectConfig, SqliteEngine};
use conn_provider::Provider;

use crate::{
    AppState,
    auth::{self, DesktopBootstrap},
    cli::{self, Command, ServeArgs},
    environment::Environment,
    home::{self, OwnershipError, RuntimeState},
    host::Host,
    method_table,
    methods::{Deps, vcs::VcsShared},
    router,
};

#[derive(Debug)]
pub struct ServeOptions {
    pub listen: SocketAddr,
    pub state_dir: PathBuf,
    /// Canonical folders with an optional title. The server's `cwd` is its own.
    pub projects: Vec<(PathBuf, Option<String>)>,
    pub label: Option<String>,
    pub cwd: PathBuf,
    /// Started by Conn desktop with its bootstrap credential.
    pub desktop: Option<DesktopBootstrap>,
    /// How long an idle provider session stays open; `None` keeps it open.
    pub session_idle: Option<Duration>,
    /// `--sdk-host`. Read by `main` when it builds the Claude provider.
    pub sdk_host: Option<PathBuf>,
}

impl ServeOptions {
    /// Reads the `serve` command line, including a desktop bootstrap envelope. Exits on any
    /// other command, after running it.
    pub fn from_args() -> Self {
        let raw: Vec<String> = std::env::args().skip(1).collect();
        match cli::parse(raw.clone()) {
            Ok(Command::Serve(args)) => Self::from_serve_args(args, &raw),
            Ok(other) => std::process::exit(cli::run(other)),
            Err(message) => {
                eprintln!("{message}\n\n{}", cli::USAGE);
                std::process::exit(2);
            }
        }
    }

    pub fn from_serve_args(mut args: ServeArgs, raw: &[String]) -> Self {
        let mut desktop = None;
        if let Some(fd) = args.bootstrap_fd
            && let Some(envelope) = cli::read_bootstrap(fd)
        {
            let (explicit_listen, explicit_home) = cli::explicit_listen_and_home(raw);
            args.apply_bootstrap(&envelope, explicit_listen, explicit_home);
            if let Some(token) = envelope.desktop_bootstrap_token.clone() {
                let ip = args.listen.ip();
                desktop = Some(DesktopBootstrap::new(
                    token,
                    envelope.desktop_bootstrap_secret.clone(),
                    !ip.is_loopback(),
                ));
            }
        }
        if args.desktop {
            // Desktop mode offers no folder of its own (`autoBootstrapProjectFromCwd` is web only).
            let cwd = args.cwd.clone();
            args.projects
                .retain(|(root, title)| !(root == &cwd && title.is_none()));
        }
        Self {
            listen: args.listen,
            state_dir: args.state_dir,
            projects: args.projects,
            label: args.label,
            cwd: args.cwd,
            desktop,
            session_idle: args.session_idle,
            sdk_host: args.sdk_host,
        }
    }
}

/// Runs until SIGTERM or SIGINT, then stops cleanly: no new connections, open sockets close,
/// and the runtime drops every task, which kills provider children (`kill_on_drop`).
pub async fn serve(options: ServeOptions, providers: Vec<Arc<dyn Provider>>) {
    let ServeOptions {
        listen,
        state_dir,
        mut projects,
        label,
        cwd,
        desktop,
        session_idle,
        sdk_host: _,
    } = options;
    let _ownership = match home::acquire_ownership(&state_dir) {
        Ok(lock) => lock,
        Err(OwnershipError::Owned) => {
            eprintln!(
                "conn-server: another server is running on {}",
                state_dir.display()
            );
            std::process::exit(home::EXIT_STATE_DIR_OWNED);
        }
        Err(OwnershipError::Io(error)) => {
            eprintln!("conn-server: cannot use {}: {error}", state_dir.display());
            std::process::exit(1);
        }
    };
    for (root, title) in home::read_projects(&state_dir) {
        if !projects.iter().any(|(r, _)| *r == root) {
            projects.push((root, Some(title)));
        }
    }
    let projects: Vec<ProjectConfig> = projects
        .iter()
        .map(|(root, title)| ProjectConfig {
            title: title.clone().unwrap_or_else(|| {
                root.file_name()
                    .map_or_else(|| "project".into(), |n| n.to_string_lossy().into_owned())
            }),
            workspace_root: root.to_string_lossy().into_owned(),
        })
        .collect();
    let environment = Arc::new(or_exit(
        Environment::load(&state_dir, label, cwd),
        "cannot load the state directory",
    ));
    let auth = environment.auth.clone();
    let is_desktop = desktop.is_some();
    if let Some(desktop) = desktop {
        auth.set_desktop_bootstrap(desktop);
    }

    let files = Some(Arc::new(or_exit(
        conn_files::Files::open(&state_dir),
        "cannot open the files store",
    )));
    let vcs = VcsShared::default();
    let terminals = crate::methods::terminal::manager(Some(&environment));
    let host = Arc::new(Host {
        mcp: OnceLock::new(),
        files: files.clone(),
        vcs: vcs.clone(),
        terminals: terminals.clone(),
        environment: environment.clone(),
    });

    let mut config = EngineConfig::new(state_dir.join("engine.sqlite"));
    config.projects = projects;
    config.providers = providers.clone();
    config.idle_session = session_idle;
    config.host = Some(host.clone());
    config.turn_observer = Some(host.clone());
    config.checkpoints = true;
    let engine: Arc<dyn Engine> = Arc::new(or_exit(
        SqliteEngine::open(config),
        "cannot open the engine",
    ));
    let mut deps = Deps {
        engine: Some(engine.clone()),
        providers,
        environment: Some(environment.clone()),
        files,
        vcs,
        terminals: Some(terminals.clone()),
        ..Deps::default()
    };
    deps.mcp = crate::routes::mcp::service(&deps);
    if let Some(mcp) = &deps.mcp {
        let _ = host.mcp.set(mcp.clone());
    }
    let state = AppState {
        table: Arc::new(method_table(&deps)),
        auth: auth.clone(),
        descriptor: Arc::new(environment.descriptor.clone()),
        engine: Some(engine.clone()),
        deps,
    };

    let listener = match tokio::net::TcpListener::bind(listen).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("conn-server: cannot listen on {listen}: {error}");
            std::process::exit(1);
        }
    };
    let addr = or_exit(listener.local_addr(), "cannot read the listening address");
    let runtime = RuntimeState::new(&addr.ip().to_string(), addr.port(), conn_support::uuid_v4());
    if let Err(error) = runtime.publish(&state_dir) {
        eprintln!("conn-server: could not write server-runtime.json: {error}");
    }
    if let Some(mcp) = &state.deps.mcp {
        mcp.set_listen_address(addr);
    }
    println!("conn-server listening on http://{addr}");
    println!(
        "environment: {} ({})",
        environment.environment_id(),
        state_dir.display()
    );
    println!("methods: {}", state.table.coverage());
    if !is_desktop {
        // One code, valid 24 hours, spent by the first device that pairs.
        match auth.issue_pairing_code(None, auth::STARTUP_PAIRING_CODE_TTL_MS) {
            Ok(pairing) => println!("pairingUrl: {}/pair#token={}", runtime.origin, pairing.code),
            Err(error) => eprintln!("conn-server: could not issue a pairing code: {error}"),
        }
    }

    let app = router(state).into_make_service_with_connect_info::<SocketAddr>();
    let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
    let server = axum::serve(listener, app).with_graceful_shutdown(async move {
        let _ = stop_rx.wait_for(|stop| *stop).await;
    });
    let mut server = std::pin::pin!(server.into_future());
    tokio::select! {
        result = &mut server => {
            if let Err(error) = result {
                eprintln!("conn-server: {error}");
            }
        }
        signal = shutdown_signal(is_desktop) => {
            eprintln!("conn-server: {signal}, stopping");
            let _ = stop_tx.send(true);
            // Open WebSockets keep the graceful stop waiting; give them a moment, no more.
            let _ = tokio::time::timeout(Duration::from_secs(2), &mut server).await;
        }
    }
    // Shells and provider processes end with their whole process groups, so nothing they
    // started outlives the server.
    terminals.shutdown().await;
    engine.shutdown().await;
    runtime.clear(&state_dir);
}

/// A start-up step that failed: print why and exit with status 1 instead of a panic.
pub fn or_exit<T, E: std::fmt::Display>(result: Result<T, E>, what: &str) -> T {
    match result {
        Ok(value) => value,
        Err(error) => {
            eprintln!("conn-server: {what}: {error}");
            std::process::exit(1);
        }
    }
}

/// Resolves on SIGTERM (systemd, Conn desktop) or SIGINT (a terminal), or, for a desktop
/// backend, when the desktop that started it is gone (`launcherWatch.ts`).
async fn shutdown_signal(watch_parent: bool) -> &'static str {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = or_exit(signal(SignalKind::terminate()), "cannot handle SIGTERM");
        let mut int = or_exit(signal(SignalKind::interrupt()), "cannot handle SIGINT");
        let parent = std::os::unix::process::parent_id();
        let parent_gone = async move {
            if !watch_parent {
                return std::future::pending().await;
            }
            let mut tick = tokio::time::interval(Duration::from_secs(2));
            loop {
                tick.tick().await;
                if std::os::unix::process::parent_id() != parent {
                    return;
                }
            }
        };
        tokio::select! {
            _ = term.recv() => "SIGTERM",
            _ = int.recv() => "SIGINT",
            _ = parent_gone => "the desktop that started this server exited",
        }
    }
    #[cfg(not(unix))]
    {
        let _ = watch_parent;
        let _ = tokio::signal::ctrl_c().await;
        "Ctrl-C"
    }
}
