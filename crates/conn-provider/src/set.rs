//! The configured provider instances, shared by the engine, titles and the server, and
//! changed while the server runs: T3's `ProviderInstanceRegistry` adds an instance when the
//! settings add one and drops it when they remove it.

use std::sync::{Arc, RwLock};

use crate::Provider;

/// A cheap handle to the one list of provider instances. Clones share it.
#[derive(Clone, Default)]
pub struct ProviderSet(Arc<RwLock<Vec<Arc<dyn Provider>>>>);

impl std::fmt::Debug for ProviderSet {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list()
            .entries(
                self.snapshot()
                    .iter()
                    .map(|p| p.instance_id().as_str().to_owned()),
            )
            .finish()
    }
}

impl From<Vec<Arc<dyn Provider>>> for ProviderSet {
    fn from(providers: Vec<Arc<dyn Provider>>) -> Self {
        Self(Arc::new(RwLock::new(providers)))
    }
}

impl ProviderSet {
    /// The instances now, in order. Hold the copy, not a lock, across an await.
    pub fn snapshot(&self) -> Vec<Arc<dyn Provider>> {
        // A poisoned lock means a panic, which aborts the process (`panic = "abort"`).
        self.0.read().map(|p| p.clone()).unwrap_or_default()
    }

    pub fn len(&self) -> usize {
        self.0.read().map(|p| p.len()).unwrap_or_default()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The instance with this id.
    pub fn get(&self, instance_id: &str) -> Option<Arc<dyn Provider>> {
        self.0
            .read()
            .ok()?
            .iter()
            .find(|p| p.instance_id().as_str() == instance_id)
            .cloned()
    }

    /// As a turn start finds it: the named instance, or the one configured provider when the
    /// run names none.
    pub fn resolve(&self, instance_id: &str) -> Option<Arc<dyn Provider>> {
        let providers = self.0.read().ok()?;
        providers
            .iter()
            .find(|p| p.instance_id().as_str() == instance_id)
            .or_else(|| {
                (instance_id.is_empty() && providers.len() == 1)
                    .then(|| providers.first())
                    .flatten()
            })
            .cloned()
    }

    /// Replaces the list. Sessions already open keep their provider; the instance's
    /// state lives on until the last of them closes.
    pub fn replace(&self, providers: Vec<Arc<dyn Provider>>) {
        if let Ok(mut current) = self.0.write() {
            *current = providers;
        }
    }
}
