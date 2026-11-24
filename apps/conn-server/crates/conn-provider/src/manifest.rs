//! What the server shares with its providers: [`LiveManifest`], the model manifest it accepted
//! last (T3's `ModelManifest.current`), and [`StatusNotifier`], how a provider reports that its
//! entry changed.

use std::sync::{Arc, RwLock};

use serde_json::Value;

/// The accepted manifest, or none: then the providers use the manifest bundled at build time.
/// The server sets it when it loads a newer disk cache or accepts a fetch; providers read it
/// on every probe, so the next probe shows it. Cheap to clone; clones share the manifest.
#[derive(Clone, Debug, Default)]
pub struct LiveManifest(Arc<RwLock<Option<Arc<Value>>>>);

impl LiveManifest {
    /// Replaces the manifest.
    pub fn set(&self, manifest: Value) {
        let mut current = self
            .0
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *current = Some(Arc::new(manifest));
    }

    /// `None` while no manifest was set (the bundled one holds). Otherwise the set manifest's
    /// catalog for `driver` (`manifest.providers[driver]`), `Some(None)` when it has none.
    pub fn provider_catalog(&self, driver: &str) -> Option<Option<Value>> {
        let current = self
            .0
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let manifest = current.as_ref()?;
        Some(
            manifest
                .get("providers")
                .and_then(|providers| providers.get(driver))
                .cloned(),
        )
    }
}

/// Tells the config streams that a provider entry changed (T3's `ProviderRegistry.streamChanges`).
/// The server listens; a provider notifies when its entry changes outside a probe the server
/// awaits, such as a sign-in that ended while a session started. Cheap to clone.
#[derive(Clone, Debug)]
pub struct StatusNotifier(Arc<tokio::sync::watch::Sender<u64>>);

impl Default for StatusNotifier {
    fn default() -> Self {
        Self(Arc::new(tokio::sync::watch::channel(0).0))
    }
}

impl StatusNotifier {
    pub fn notify(&self) {
        self.0
            .send_modify(|revision| *revision = revision.wrapping_add(1));
    }

    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<u64> {
        self.0.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clones_share_the_manifest() {
        let live = LiveManifest::default();
        assert_eq!(live.provider_catalog("codex"), None);
        let reader = live.clone();
        live.set(json!({"providers": {"codex": {"models": []}}}));
        assert_eq!(
            reader.provider_catalog("codex"),
            Some(Some(json!({"models": []})))
        );
        assert_eq!(reader.provider_catalog("antigravity"), Some(None));
    }
}
