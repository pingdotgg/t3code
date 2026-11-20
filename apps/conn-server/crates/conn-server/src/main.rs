use std::sync::Arc;

use conn_provider::Provider;
use conn_provider_claude::{ClaudeConfig, ClaudeProvider, HelperCommand};
use conn_server::serve::{ServeOptions, serve_with_instances};

fn main() {
    // T3's binMain dispatches the bridge before loading the server CLI.
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("acp-mcp-bridge")) {
        std::process::exit(conn_server::acp_mcp_bridge::main());
    }
    // Antigravity's `BROWSER`: reports a sign-in URL instead of opening a browser.
    if std::env::args_os().nth(1).as_deref()
        == Some(std::ffi::OsStr::new(conn_provider_acp::BROWSER_SUBCOMMAND))
    {
        let args: Vec<String> = std::env::args_os()
            .skip(2)
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        std::process::exit(conn_provider_acp::browser_main(&args));
    }
    run_server();
}

fn run_server() {
    // Runs and exits for every command but `serve`.
    let options = ServeOptions::from_args();
    // `fixPath`: the login shell's PATH for every child and every program lookup, read before
    // the providers are detected (Codex looks for its binary on that PATH). Blocking is fine:
    // the runtime does not exist yet.
    conn_support::login_env::hydrate();
    let mut claude = ClaudeConfig {
        // `conn-files` stores attachments here; the CLI may read them.
        attachments_dir: Some(options.state_dir.join("attachments")),
        // T3 runs its Claude status probe in its state folder.
        status_cwd: Some(options.state_dir.clone()),
        // Checks turn the probe off, so they never run this machine's `claude`.
        status_probe: std::env::var_os("CONN_CLAUDE_STATUS_PROBE").is_none_or(|v| v != "off"),
        // The engine closes idle sessions (`--session-idle-timeout`), one rule for all.
        idle_timeout: None,
        // T3's text after the runtime instructions when the session has `t3-code`.
        mcp_instructions: Some(format!(
            "{}{}",
            conn_mcp::AGENT_INSTRUCTIONS,
            conn_mcp::CLAUDE_INSTRUCTIONS
        )),
        device_instructions: Some(conn_mcp::DEVICE_INSTRUCTIONS.to_owned()),
        ..ClaudeConfig::default()
    };
    if let Some(helper) = &options.sdk_host {
        claude.helper = HelperCommand::from_path(helper);
    }
    let codex = conn_provider_codex::CodexConfig {
        // The same store Claude reads; Codex gets a path line per attachment and the images.
        attachments_dir: Some(options.state_dir.join("attachments")),
        // Checks turn the probe off, so they never run this machine's `codex`.
        status_probe: std::env::var_os("CONN_CODEX_STATUS_PROBE").is_none_or(|v| v != "off"),
        // T3 probes Codex in the server's working folder (`process.cwd()`).
        status_cwd: std::env::current_dir().ok(),
        ..Default::default()
    };
    // One SDK host process for every Claude instance (it runs only while a query is open).
    let claude_host = conn_provider_claude::helper::claude_host(
        claude.helper.clone(),
        conn_provider_claude::DRIVER,
    );
    let antigravity = conn_provider_acp::AntigravityConfig {
        state_dir: options.state_dir.clone(),
        attachments_dir: Some(options.state_dir.join("attachments")),
        self_command: None,
    };
    // `claudeAgent`, `codex` and `antigravity`, and one more provider per `providerInstances`
    // entry of these drivers, each with its entry's settings (`conn_server::instances`).
    let instances = Arc::new(conn_server::instances::Instances::new(
        &[
            conn_provider_claude::DRIVER,
            conn_provider_codex::DRIVER,
            conn_provider_acp::ANTIGRAVITY.driver,
        ],
        Arc::new(
            move |id: &str, driver: &str, entry: Option<&serde_json::Value>| {
                let provider: Arc<dyn Provider> = if driver == conn_provider_acp::ANTIGRAVITY.driver
                {
                    Arc::new(conn_provider_acp::AntigravityProvider::for_instance(
                        id.into(),
                        antigravity.clone(),
                        entry,
                    ))
                } else if driver == conn_provider_claude::DRIVER {
                    Arc::new(ClaudeProvider::for_instance(
                        id.into(),
                        claude.clone(),
                        entry,
                        &claude_host,
                    ))
                } else {
                    Arc::new(conn_provider_codex::CodexProvider::for_instance(
                        id.into(),
                        codex.clone(),
                        entry,
                    ))
                };
                Some(provider)
            },
        ),
    ));
    // T3's default `grok` instance: off until `providerInstances.grok` enables it. It starts
    // with the stored settings, so a Grok task due at start can run; the server's status task
    // applies later changes and probes the CLI.
    let grok: Arc<dyn Provider> = Arc::new(conn_provider_acp::AcpProvider::with_settings(
        "grok".into(),
        &conn_provider_acp::GROK,
        conn_provider_acp::AcpConfig {
            workspace_cwd: Some(options.cwd.clone()),
            // The same store Claude and Codex read.
            attachments_dir: Some(options.state_dir.join("attachments")),
            ..Default::default()
        },
        conn_server::serve::stored_grok_settings(&options.state_dir),
    ));
    // One thread: a container serves a handful of clients, and each worker thread costs
    // stack and allocator arenas.
    let runtime = conn_server::serve::or_exit(
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build(),
        "cannot start the runtime",
    );
    runtime.block_on(serve_with_instances(options, vec![grok], Some(instances)));
    // Dropping the tasks drops provider children, which kills them (`kill_on_drop`).
    runtime.shutdown_timeout(std::time::Duration::from_secs(2));
}
