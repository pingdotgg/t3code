//! The Claude provider: drives the `claude` CLI over its stdio stream-JSON protocol and
//! implements [`conn_provider::Provider`].
//!
//! Stub. Track (c) builds it. Reference behaviour: `ClaudeAdapterV2.ts` in
//! `apps/server/src/orchestration-v2/Adapters`, recorded sessions in
//! `apps/server/src/orchestration-v2/testkit`, and the stdio probe in
//! `~/apps/conn-rust-claude-probe`.

use std::path::PathBuf;

use conn_contract::{ProviderCapabilities, ProviderInstanceId, from_json};
use conn_provider::{
    BoxFuture, OpenSessionInput, OpenedSession, Provider, ProviderError, ProviderResult,
};

/// The contract's `ProviderDriverKind` for Claude.
pub const DRIVER: &str = "claudeAgent";

pub struct ClaudeProvider {
    instance_id: ProviderInstanceId,
    /// The `claude` executable.
    pub binary: PathBuf,
}

impl ClaudeProvider {
    pub fn new(instance_id: ProviderInstanceId, binary: PathBuf) -> Self {
        Self {
            instance_id,
            binary,
        }
    }
}

impl Provider for ClaudeProvider {
    fn instance_id(&self) -> &ProviderInstanceId {
        &self.instance_id
    }

    fn driver(&self) -> &str {
        DRIVER
    }

    fn capabilities(&self) -> BoxFuture<'_, ProviderResult<ProviderCapabilities>> {
        Box::pin(async {
            from_json(serde_json::json!({})).map_err(|e| ProviderError::Protocol {
                detail: e.to_string(),
            })
        })
    }

    fn open_session(
        &self,
        _input: OpenSessionInput,
    ) -> BoxFuture<'_, ProviderResult<OpenedSession>> {
        Box::pin(async {
            Err(ProviderError::Unsupported {
                operation: "open_session",
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_as_a_dyn_provider() {
        let provider: Box<dyn Provider> =
            Box::new(ClaudeProvider::new("claude".into(), "claude".into()));
        assert_eq!(provider.driver(), DRIVER);
        assert_eq!(provider.instance_id().as_str(), "claude");
    }
}
