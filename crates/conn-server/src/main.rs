use std::sync::Arc;

use conn_provider::Provider;
use conn_provider_claude::{ClaudeConfig, ClaudeProvider, HelperCommand};
use conn_server::serve::{ServeOptions, serve};

fn main() {
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
        ..ClaudeConfig::default()
    };
    if let Some(helper) = &options.sdk_host {
        claude.helper = HelperCommand::from_path(helper);
    }
    let mut providers: Vec<Arc<dyn Provider>> =
        vec![Arc::new(ClaudeProvider::new("claudeAgent".into(), claude))];
    let codex = conn_provider_codex::CodexConfig {
        // The same store Claude reads; Codex gets a path line per attachment and the images.
        attachments_dir: Some(options.state_dir.join("attachments")),
        ..Default::default()
    };
    if let Some(codex) = conn_provider_codex::CodexProvider::detect("codex".into(), codex) {
        providers.push(Arc::new(codex));
    }
    // T3's default `grok` instance: off until `providerInstances.grok` enables it. It starts
    // with the stored settings, so a Grok task due at start can run; the server's status task
    // applies later changes and probes the CLI.
    providers.push(Arc::new(conn_provider_acp::AcpProvider::with_settings(
        "grok".into(),
        &conn_provider_acp::GROK,
        conn_provider_acp::AcpConfig {
            workspace_cwd: Some(options.cwd.clone()),
            // The same store Claude and Codex read.
            attachments_dir: Some(options.state_dir.join("attachments")),
            ..Default::default()
        },
        conn_server::serve::stored_grok_settings(&options.state_dir),
    )));
    // One thread: a container serves a handful of clients, and each worker thread costs
    // stack and allocator arenas.
    let runtime = conn_server::serve::or_exit(
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build(),
        "cannot start the runtime",
    );
    runtime.block_on(serve(options, providers));
    // Dropping the tasks drops provider children, which kills them (`kill_on_drop`).
    runtime.shutdown_timeout(std::time::Duration::from_secs(2));
}
