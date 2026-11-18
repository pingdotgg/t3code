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

/// Grok's `providerInstances.grok` settings as stored in `<state_dir>/settings.json`, so a Grok
/// task due at start does not meet a disabled instance before the first status refresh. Reads
/// the file with `std::fs`: call it before the runtime starts. A file that does not parse
/// gives Grok's default (off); the settings store logs it.
pub fn stored_grok_settings(state_dir: &std::path::Path) -> conn_provider_acp::GrokSettings {
    let stored = crate::settings::read(&state_dir.join("settings.json")).unwrap_or_default();
    conn_provider_acp::GrokSettings::from_instance(
        stored.get("providerInstances").and_then(|p| p.get("grok")),
    )
}

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
    /// `--managed-provision`: serve managed callers on a second ingress
    /// (`crate::managed`).
    pub managed_provision: Option<PathBuf>,
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
            managed_provision: args.managed_provision,
        }
    }
}

/// The caller reads the login environment first (`conn_support::login_env::hydrate`), before
/// it detects `providers`.
///
/// Runs until SIGTERM or SIGINT, then stops cleanly: no new connections, open sockets close,
/// and the runtime drops every task, which kills provider children (`kill_on_drop`).
pub async fn serve(options: ServeOptions, providers: Vec<Arc<dyn Provider>>) {
    serve_with_instances(options, providers, None).await;
}

/// [`serve`] with Claude and Codex instances built from `providerInstances`: at start from the
/// stored settings (as Orbit writes them before the first boot), and again on every change.
/// `providers` are the fixed ones (Grok), listed after them.
pub async fn serve_with_instances(
    options: ServeOptions,
    providers: Vec<Arc<dyn Provider>>,
    instances: Option<Arc<crate::instances::Instances>>,
) {
    let ServeOptions {
        listen,
        state_dir,
        mut projects,
        label,
        cwd,
        desktop,
        session_idle,
        sdk_host: _,
        managed_provision,
    } = options;
    // A managed target never starts on partial input.
    let provision = match managed_provision {
        Some(path) => Some(or_exit(
            or_exit(
                tokio::task::spawn_blocking(move || crate::managed::Provision::load(&path)).await,
                "cannot read the managed provisioning",
            ),
            "managed provisioning refused",
        )),
        None => None,
    };
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
    let restart = crate::restart::Restart::detect(desktop.is_some()).await;
    let load_environment = {
        let state_dir = state_dir.clone();
        tokio::task::spawn_blocking(move || Environment::load(&state_dir, label, cwd, restart))
    };
    let environment = or_exit(
        or_exit(
            load_environment.await,
            "cannot start the environment loader",
        ),
        "cannot load the state directory",
    );
    let environment = Arc::new(environment);
    let restart = environment.restart.clone();
    let auth = environment.auth.clone();
    let providers = conn_provider::ProviderSet::from(providers);
    if let Some(instances) = &instances {
        instances
            .reconcile(&providers, &environment.settings.raw())
            .await;
    }
    let provider_names = providers
        .snapshot()
        .iter()
        .map(|p| p.instance_id().as_str().to_owned())
        .collect::<Vec<_>>()
        .join(", ");
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
        scheduled_tasks: OnceLock::new(),
    });

    let mut config = EngineConfig::new(state_dir.join("engine.sqlite"));
    config.projects = projects;
    config.provider_set = Some(providers.clone());
    config.idle_session = session_idle;
    config.host = Some(host.clone());
    config.turn_observer = Some(host.clone());
    config.checkpoints = true;
    let text_generators = Arc::new(crate::text_generation::TextGenerators::for_environment(
        environment.clone(),
    ));
    config.title_generator = Some(Arc::new(
        crate::text_generation::title::Titles::new(text_generators.clone())
            .with_providers(providers.clone(), Some(state_dir.join("attachments"))),
    ));
    let engine: Arc<dyn Engine> = Arc::new(or_exit(
        SqliteEngine::open(config),
        "cannot open the engine",
    ));
    let secrets = conn_features::secrets::SecretRequests::new(
        &state_dir,
        engine.clone(),
        Arc::new(conn_features::clock::SystemClock),
    );
    let scheduled_tasks =
        conn_features::scheduled::ScheduledTasks::start(conn_features::scheduled::Config {
            state_dir: state_dir.clone(),
            clock: Arc::new(conn_features::clock::SystemClock),
            zone: jiff::tz::TimeZone::system(),
            runner: Arc::new(conn_features::scheduled::EngineRunner::new(engine.clone())),
            secret_requests: Some(secrets.clone()),
            start_timer: true,
        })
        .await;
    let _ = host.scheduled_tasks.set(scheduled_tasks.clone());
    let preview = conn_preview::tabs::Preview::new(state_dir.clone());
    let mut deps = Deps {
        preview: Some(preview.clone()),
        panels: Some(conn_features::panels::PanelBroker::default()),
        secrets: Some(secrets),
        test_logins: Some(conn_features::test_logins::TestLogins::new(&state_dir)),
        engine: Some(engine.clone()),
        scheduled_tasks: Some(scheduled_tasks),
        annotations: Some(conn_features::annotations::Annotations::new(
            &state_dir,
            Arc::new(conn_features::clock::SystemClock),
            Arc::new(conn_features::annotations::EngineProjects(engine.clone())),
        )),
        providers,
        instances,
        environment: Some(environment.clone()),
        files,
        vcs,
        terminals: Some(terminals.clone()),
        text_generators: Some(text_generators),
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
    // The write and its fsync run on a blocking thread, as all file work here does.
    let published = {
        let (runtime, state_dir) = (runtime.clone(), state_dir.clone());
        tokio::task::spawn_blocking(move || runtime.publish(&state_dir)).await
    };
    match published {
        Ok(Ok(())) => {}
        Ok(Err(error)) => eprintln!("conn-server: could not write server-runtime.json: {error}"),
        Err(error) => eprintln!("conn-server: could not write server-runtime.json: {error}"),
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
    println!("providers: {provider_names}");
    // Probes spawn provider CLIs; T3 starts them once the server is ready, too.
    crate::methods::provider::start_status_refresh(&state.deps);
    // `model-manifest.json`, fetched and cached as the T3 server's provider checks do.
    crate::model_manifest::start(state_dir.clone(), environment.clone());
    let managed_server = match provision {
        Some(provision) => Some(start_managed(provision, &environment, &state).await),
        None => None,
    };
    if !is_desktop && managed_server.is_none() {
        // One code, valid 24 hours, spent by the first device that pairs. A managed target
        // shows none: its native ingress is the restricted fixture path.
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
        signal = async {
            tokio::select! {signal=shutdown_signal(is_desktop)=>signal, ()=restart.wait()=>"restart requested"}
        } => {
            eprintln!("conn-server: {signal}, stopping");
            // Mark shutdown before draining: provider exits must leave runs for restart recovery.
            engine.begin_shutdown();
            let _ = stop_tx.send(true);
            // Open WebSockets keep the graceful stop waiting; give them a moment, no more.
            let _ = tokio::time::timeout(Duration::from_secs(2), &mut server).await;
        }
    }
    if let Some(managed) = managed_server {
        managed.abort();
    }
    // Shells and provider processes end with their whole process groups, so nothing they
    // started outlives the server.
    terminals.shutdown().await;
    engine.shutdown().await;
    preview.shutdown().await;
    let _ = tokio::task::spawn_blocking(move || runtime.clear(&state_dir)).await;
    if restart.requested() {
        // A failure exit also restarts units with Restart=on-failure.
        std::process::exit(1);
    }
}

/// Binds the managed ingress and starts its authority, probe, lease, ACK and notice tasks.
/// Exits when the provisioning names another environment than this state directory's.
async fn start_managed(
    provision: crate::managed::Provision,
    environment: &Environment,
    state: &crate::AppState,
) -> tokio::task::JoinHandle<()> {
    use crate::managed::{self, gateway::Gateway};
    if provision.environment_id != environment.environment_id() {
        eprintln!("conn-server: managed provisioning names another environment");
        std::process::exit(1);
    }
    let gateway: Arc<dyn Gateway> = Arc::new(or_exit(
        managed::gateway::HttpsGateway::new(&provision),
        "managed gateway",
    ));
    let tls = or_exit(managed::gateway::lab_tls(&provision.ca_pem), "managed CA");
    let shared = managed::Shared::new(provision.environment_id.clone(), provision.generation);
    shared.spawn(gateway.clone());
    tokio::spawn(managed::notices::run(
        shared.clone(),
        gateway.clone(),
        tls,
        provision.generation,
    ));
    let listener = match tokio::net::TcpListener::bind(provision.listen).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!(
                "conn-server: cannot listen on {} (managed): {error}",
                provision.listen
            );
            std::process::exit(1);
        }
    };
    if let Ok(addr) = listener.local_addr() {
        println!("managed ingress on http://{addr}");
    }
    let ingress = managed::ingress::Managed::new(shared, gateway, provision.preview_tabs);
    let app = managed::ingress::router(state.clone(), ingress);
    tokio::spawn(async move {
        if let Err(error) = managed::conn::serve(listener, app).await {
            eprintln!("conn-server: managed ingress: {error}");
        }
    })
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
            let mut tick = crate::http::check_every(Duration::from_secs(2));
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

#[cfg(test)]
mod stored_grok_settings_tests {
    use super::stored_grok_settings;

    /// Finding 6: Grok starts with the stored settings, not the default (off).
    #[test]
    fn grok_starts_with_the_stored_settings() {
        let dir = std::env::temp_dir().join(format!(
            "conn-serve-grok-{}-{}",
            std::process::id(),
            conn_support::uuid_v4()
        ));
        std::fs::create_dir_all(&dir).expect("dir");
        assert!(!stored_grok_settings(&dir).enabled, "no file: off");
        std::fs::write(
            dir.join("settings.json"),
            r#"{"providerInstances":{"grok":{"driver":"grok","enabled":true,
                "config":{"binaryPath":"/opt/grok"}}}}"#,
        )
        .expect("settings");
        let settings = stored_grok_settings(&dir);
        std::fs::write(dir.join("settings.json"), "{not json").expect("settings");
        let broken = stored_grok_settings(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(settings.enabled);
        assert_eq!(settings.binary_path, "/opt/grok");
        assert!(!broken.enabled, "a broken file: off");
    }
}
