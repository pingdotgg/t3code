//! `provider.*` methods (provider status, models, auth). Owner: track (c), Claude provider.
//!
//! No `provider.*` method gates a Claude turn. The client reads providers and their models from
//! `ServerConfig.providers`, which `subscribeServerConfig` delivers at connect (track a). A
//! `claudeAgent` entry must be enabled, installed and `status: "ready"`
//! (`apps/web/src/providerInstances.ts`), or the composer has no model to send with.
//! [`server_providers`] builds those entries for track (a) to put into the server config.
//!
//! Client callers of the other provider methods, none on the send path:
//! - `server.refreshProviders`: model picker on open, only when the server advertises
//!   `environment.capabilities.modelCatalogRefresh`; failures are not reported.
//! - `provider.auth.*`, `provider.install.*`: Settings and the setup wizard.
//! - `server.updateProvider`, `server.listTextGeneratorModels`, ACP registry methods,
//!   `provider.uploadFeedback`, `provider.consumeResetCredit`: Settings or explicit actions.
//!
//! They stay unregistered and answer "not supported".

use serde_json::Value;

use super::Deps;
use crate::table::MethodTable;

pub fn register(_table: &mut MethodTable, _deps: &Deps) {}

/// `ServerConfig.providers` entries for the configured providers. `checked_at` is ISO-8601.
pub fn server_providers(deps: &Deps, checked_at: &str) -> Vec<Value> {
    deps.providers
        .iter()
        .filter(|p| p.driver() == conn_provider_claude::DRIVER)
        .map(|p| conn_provider_claude::server_provider_entry(p.instance_id().as_str(), checked_at))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use conn_provider_claude::{ClaudeConfig, ClaudeProvider};

    use super::*;

    #[test]
    fn a_claude_instance_is_offered_ready_with_models() {
        let deps = Deps {
            engine: None,
            providers: vec![Arc::new(ClaudeProvider::new(
                "claudeAgent".into(),
                ClaudeConfig::default(),
            ))],
            ..Deps::default()
        };
        let entries = server_providers(&deps, "2026-11-13T00:00:00.000Z");
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry["instanceId"], "claudeAgent");
        assert_eq!(entry["driver"], "claudeAgent");
        assert_eq!(entry["status"], "ready");
        assert_eq!(entry["enabled"], true);
        assert_eq!(entry["installed"], true);
        assert!(!entry["models"].as_array().unwrap().is_empty());
    }
}
