//! `conn-server` with the engine's scripted fake provider in place of Claude, for
//! `tools/replay.mjs`: same flags, same routes, no model calls.

use std::sync::Arc;

use conn_contract::{ProviderCapabilities, ProviderInstanceId};
use conn_engine::fake::FakeProvider;
use conn_provider::{BoxFuture, OpenSessionInput, OpenedSession, Provider, ProviderResult};
use conn_server::serve::{ServeOptions, serve};

/// The fake provider, listed to clients and to `/mcp` as the Claude provider it stands in for.
/// Without an entry in `ServerConfig.providers`, `/mcp` refuses to launch a thread on it.
struct ListedAsClaude(FakeProvider, Option<std::path::PathBuf>);

impl Provider for ListedAsClaude {
    fn instance_id(&self) -> &ProviderInstanceId {
        self.0.instance_id()
    }

    fn driver(&self) -> &str {
        self.0.driver()
    }

    fn capabilities(&self) -> BoxFuture<'_, ProviderResult<ProviderCapabilities>> {
        self.0.capabilities()
    }

    fn open_session(
        &self,
        input: OpenSessionInput,
    ) -> BoxFuture<'_, ProviderResult<OpenedSession>> {
        Box::pin(async move {
            if let Some(path) = &self.1 {
                let path = path.clone();
                let entries: Vec<_> = input.mcp_servers.iter().map(|s|serde_json::json!({
                    "url":s.url,"headers":s.headers.iter().cloned().collect::<std::collections::BTreeMap<_,_>>(),
                })).collect();
                let value =
                    serde_json::json!({"threadId":input.thread_id,"servers":entries}).to_string();
                let _ = tokio::task::spawn_blocking(move || std::fs::write(path, value)).await;
            }
            self.0.open_session(input).await
        })
    }

    fn server_provider_entry(&self, checked_at: &str) -> Option<serde_json::Value> {
        Some(conn_provider_claude::server_provider_entry(
            self.0.instance_id().as_str(),
            checked_at,
        ))
    }
}

fn main() {
    let options = ServeOptions::from_args();
    let capture = std::env::var_os("REPLAY_MCP_CAPTURE").map(std::path::PathBuf::from);
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
        .block_on(serve(
            options,
            vec![Arc::new(ListedAsClaude(
                FakeProvider::new("claudeAgent"),
                capture,
            ))],
        ));
}
