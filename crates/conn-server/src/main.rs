use std::sync::Arc;

use conn_provider::Provider;
use conn_provider_claude::{ClaudeConfig, ClaudeProvider, HelperCommand};
use conn_server::serve::{ServeOptions, serve};

fn main() {
    // Runs and exits for every command but `serve`.
    let options = ServeOptions::from_args();
    let mut claude = ClaudeConfig {
        // `conn-files` stores attachments here; the CLI may read them.
        attachments_dir: Some(options.state_dir.join("attachments")),
        // The engine closes idle sessions (`--session-idle-timeout`), one rule for all.
        idle_timeout: None,
        // T3's text after the runtime instructions when the session has `t3-code`.
        mcp_instructions: Some(format!(
            "{}{}",
            conn_mcp::AGENT_INSTRUCTIONS,
            conn_mcp::CLAUDE_BACKGROUND_WAIT_INSTRUCTIONS
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
    // One thread: a container serves a handful of clients, and each worker thread costs
    // stack and allocator arenas.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    runtime.block_on(serve(options, providers));
    // Dropping the tasks drops provider children, which kills them (`kill_on_drop`).
    runtime.shutdown_timeout(std::time::Duration::from_secs(2));
}
