//! `conn-server` with the engine's scripted fake provider in place of Claude, for
//! `tools/replay.mjs`: same flags, same routes, no model calls.

use std::sync::Arc;

use conn_contract::{ProviderCapabilities, ProviderInstanceId};
use conn_engine::fake::FakeProvider;
use conn_provider::{BoxFuture, OpenSessionInput, OpenedSession, Provider, ProviderResult};
use conn_server::serve::{ServeOptions, serve};

/// The fake provider, listed to clients and to `/mcp` as the Claude provider it stands in for.
/// Without an entry in `ServerConfig.providers`, `/mcp` refuses to launch a thread on it.
struct ListedAsClaude(FakeProvider);

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
        self.0.open_session(input)
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
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
        .block_on(serve(
            options,
            vec![Arc::new(ListedAsClaude(FakeProvider::new("claudeAgent")))],
        ));
}
