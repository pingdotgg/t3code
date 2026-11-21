//! The agent wiring, end to end: a Conn Server with the scripted fake provider, one thread,
//! and that thread's `t3-code` MCP entry written as a Claude `--mcp-config` file. Start
//! `claude --mcp-config <file>` against it to act as that thread's agent.
//!
//! `cargo run -p conn-server --example mcp_agent -- <state-dir> <project-dir> <config-out>`

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use conn_engine::{Engine, EngineConfig, ProjectConfig, SqliteEngine, fake::FakeProvider};
use conn_mcp::ThreadCredentialRequest;
use conn_server::{
    AppState, auth::AuthStore, environment::Environment, method_table, methods::Deps, router,
    routes::mcp,
};
use serde_json::json;

fn main() {
    let args: Vec<PathBuf> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    let [state_dir, project, config_out] = args.as_slice() else {
        eprintln!("usage: mcp_agent <state-dir> <project-dir> <config-out>");
        std::process::exit(2);
    };
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
        .block_on(run(state_dir, project, config_out));
}

async fn run(state_dir: &Path, project: &Path, config_out: &Path) {
    std::fs::create_dir_all(state_dir).expect("state directory");
    let root = project.to_string_lossy().into_owned();
    let environment = Arc::new(
        Environment::load(
            state_dir,
            Some("mcp-agent".into()),
            project.to_path_buf(),
            Default::default(),
        )
        .expect("environment"),
    );
    let mut config = EngineConfig::new(state_dir.join("engine.sqlite"));
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: root.clone(),
    }];
    let provider: Arc<dyn conn_provider::Provider> = Arc::new(FakeProvider::new("claudeAgent"));
    config.providers = vec![provider.clone()];
    let engine: Arc<dyn Engine> = Arc::new(SqliteEngine::open(config).expect("engine"));
    let mut deps = Deps {
        engine: Some(engine.clone()),
        providers: vec![provider].into(),
        environment: Some(environment.clone()),
        ..Deps::default()
    };
    deps.mcp = mcp::service(&deps);
    let service = deps.mcp.clone().expect("mcp service");

    // The thread whose agent Claude plays: launched idle, as a provider session would see it.
    let thread_id = "thread:mcp-agent";
    engine
        .launch_thread(json!({
            "commandId": "mcp-agent:launch",
            "threadId": thread_id,
            "projectId": SqliteEngine::project_id_for(&root),
            "title": "Agent thread",
            "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-5-5"},
            "runtimeMode": "full-access",
            "interactionMode": "default",
            "workspaceStrategy": {"type": "root"},
        }))
        .await
        .expect("launch the agent thread");

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address = listener.local_addr().expect("local address");
    service.set_listen_address(address);
    let entry = service.issue_thread_credential(ThreadCredentialRequest {
        thread_id: thread_id.into(),
        provider_instance_id: "claudeAgent".into(),
        subagent: false,
        preview: true,
        device: false,
    });
    std::fs::write(config_out, entry.claude_mcp_config().to_string()).expect("write config");
    println!(
        "listening on http://{address}, config in {}",
        config_out.display()
    );

    let state = AppState {
        table: Arc::new(method_table(&deps)),
        auth: AuthStore::in_memory(),
        descriptor: environment.subscribe_descriptor(),
        engine: Some(engine),
        deps,
    };
    axum::serve(listener, router(state)).await.expect("serve");
}
