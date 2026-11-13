use std::sync::Arc;

use conn_provider::Provider;
use conn_provider_claude::{ClaudeConfig, ClaudeProvider};
use conn_server::serve::{ServeOptions, serve};

fn main() {
    let options = ServeOptions::from_args();
    let mut providers: Vec<Arc<dyn Provider>> = vec![Arc::new(ClaudeProvider::new(
        "claudeAgent".into(),
        ClaudeConfig::default(),
    ))];
    if let Some(codex) =
        conn_provider_codex::CodexProvider::detect("codex".into(), Default::default())
    {
        providers.push(Arc::new(codex));
    }
    // One thread: a container serves a handful of clients, and each worker thread costs
    // stack and allocator arenas.
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
        .block_on(serve(options, providers));
}
