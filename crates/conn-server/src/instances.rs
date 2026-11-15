//! Provider instances built from the settings, as T3's `ProviderInstanceRegistry` builds them
//! (`ProviderInstanceRegistryHydration.ts`, `ProviderInstanceRegistry.ts`).
//!
//! - Every driver here has a default instance whose id is the driver kind (`claudeAgent`,
//!   `codex`); it exists with no settings entry.
//! - Each `providerInstances` entry whose `driver` is one of them is one more instance
//!   (`supportsMultipleInstances`), such as Orbit's `claudeLow` … `claudeMax`.
//! - An entry that changes in any field gives a new provider for that id; a removed entry
//!   drops its instance (a default instance goes back to its defaults). Sessions already open
//!   keep the provider they opened with until they close, as in T3, where an open session
//!   keeps its adapter and the instance is rebuilt for the next session.
//!
//! Other providers (Grok) are passed in fixed and follow their settings themselves.

use std::sync::{Arc, Mutex};

use conn_provider::{Provider, ProviderSet};
use serde_json::{Map, Value};

/// Builds one provider: instance id, driver, the `providerInstances[id]` entry (`None`: the
/// default instance with no entry). `None` when the instance is not offered; Claude and
/// Codex always offer theirs (a Codex whose binary is missing is listed with T3's error
/// entry after its probe). It may read files: the caller runs it on a blocking thread.
pub type Build = dyn Fn(&str, &str, Option<&Value>) -> Option<Arc<dyn Provider>> + Send + Sync;

pub struct Instances {
    /// The drivers this builds, in the order their default instances are listed.
    drivers: Vec<String>,
    build: Arc<Build>,
    /// What each built instance was built from: one entry per live instance.
    built: Mutex<Vec<(String, Option<Value>)>>,
}

impl std::fmt::Debug for Instances {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Instances")
            .field("drivers", &self.drivers)
            .finish_non_exhaustive()
    }
}

/// One instance the settings ask for.
struct Wanted {
    id: String,
    driver: String,
    entry: Option<Value>,
}

impl Instances {
    pub fn new(drivers: &[&str], build: Arc<Build>) -> Self {
        Self {
            drivers: drivers.iter().map(|d| (*d).to_owned()).collect(),
            build,
            built: Mutex::new(Vec::new()),
        }
    }

    /// The instances the settings ask for: the default ones first, then the other entries
    /// with one of these drivers, in the settings' key order.
    fn wanted(&self, settings: &Map<String, Value>) -> Vec<Wanted> {
        let entries = settings.get("providerInstances").and_then(Value::as_object);
        let entry = |id: &str| entries.and_then(|e| e.get(id)).cloned();
        let mut wanted: Vec<Wanted> = self
            .drivers
            .iter()
            .map(|driver| Wanted {
                id: driver.clone(),
                driver: driver.clone(),
                entry: entry(driver),
            })
            .collect();
        for (id, value) in entries.into_iter().flatten() {
            let Some(driver) = value.get("driver").and_then(Value::as_str) else {
                continue;
            };
            if self.drivers.iter().any(|d| d == driver) && !wanted.iter().any(|w| &w.id == id) {
                wanted.push(Wanted {
                    id: id.clone(),
                    driver: driver.to_owned(),
                    entry: Some(value.clone()),
                });
            }
        }
        wanted
    }

    /// Whether `id` is an instance this builds.
    fn manages(&self, id: &str) -> bool {
        crate::lock(&self.built).iter().any(|(b, _)| b == id)
            || self.drivers.iter().any(|d| d == id)
    }

    /// Brings `providers` in line with `settings`: builds what is new or changed, drops what
    /// was removed, keeps the rest (fixed providers included) as they are. Returns the ids of
    /// the instances it built, to be probed.
    pub async fn reconcile(
        &self,
        providers: &ProviderSet,
        settings: &Map<String, Value>,
    ) -> Vec<String> {
        let wanted = self.wanted(settings);
        let current = providers.snapshot();
        let built_before = crate::lock(&self.built).clone();
        let mut next: Vec<Arc<dyn Provider>> = Vec::new();
        let mut built_now: Vec<(String, Option<Value>)> = Vec::new();
        let mut rebuilt = Vec::new();
        for want in wanted {
            let existing = current
                .iter()
                .find(|p| p.instance_id().as_str() == want.id)
                .filter(|_| {
                    built_before
                        .iter()
                        .any(|(id, entry)| *id == want.id && *entry == want.entry)
                });
            let provider = match existing {
                Some(provider) => Some(provider.clone()),
                None => {
                    let build = self.build.clone();
                    let (id, driver, entry) =
                        (want.id.clone(), want.driver.clone(), want.entry.clone());
                    let made =
                        tokio::task::spawn_blocking(move || build(&id, &driver, entry.as_ref()))
                            .await
                            .ok()
                            .flatten();
                    rebuilt.push(want.id.clone());
                    made
                }
            };
            // An instance that is not offered is tried again on the next settings change.
            built_now.push((want.id.clone(), want.entry));
            if let Some(provider) = provider {
                next.push(provider);
            }
        }
        // Fixed providers keep their place after the built ones.
        let fixed = current
            .into_iter()
            .filter(|p| !self.manages(p.instance_id().as_str()));
        next.extend(fixed);
        *crate::lock(&self.built) = built_now;
        providers.replace(next);
        rebuilt
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Named(conn_contract::ProviderInstanceId);

    impl Provider for Named {
        fn instance_id(&self) -> &conn_contract::ProviderInstanceId {
            &self.0
        }
        fn driver(&self) -> &str {
            "fake"
        }
        fn capabilities(
            &self,
        ) -> conn_provider::BoxFuture<
            '_,
            conn_provider::ProviderResult<conn_contract::ProviderCapabilities>,
        > {
            Box::pin(async {
                Err(conn_provider::ProviderError::Unsupported {
                    operation: "capabilities",
                })
            })
        }
        fn open_session(
            &self,
            _input: conn_provider::OpenSessionInput,
        ) -> conn_provider::BoxFuture<'_, conn_provider::ProviderResult<conn_provider::OpenedSession>>
        {
            Box::pin(async {
                Err(conn_provider::ProviderError::Unsupported {
                    operation: "open_session",
                })
            })
        }
    }

    fn fake(id: &str) -> Arc<dyn Provider> {
        Arc::new(Named(id.into()))
    }

    fn instances(log: Arc<Mutex<Vec<String>>>) -> Instances {
        Instances::new(
            &["claudeAgent", "codex"],
            Arc::new(move |id: &str, driver: &str, entry: Option<&Value>| {
                crate::lock(&log).push(format!("{id}:{driver}:{}", entry.is_some()));
                // A disabled entry still gives a provider; a codex with "missing" does not.
                if entry.and_then(|e| e["config"]["binaryPath"].as_str()) == Some("missing") {
                    return None;
                }
                Some(fake(id))
            }),
        )
    }

    fn ids(set: &ProviderSet) -> Vec<String> {
        set.snapshot()
            .iter()
            .map(|p| p.instance_id().as_str().to_owned())
            .collect()
    }

    fn settings(value: Value) -> Map<String, Value> {
        let Value::Object(map) = value else { panic!() };
        map
    }

    #[tokio::test]
    async fn instances_follow_the_settings() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let instances = instances(log.clone());
        let grok = fake("grok");
        let set = ProviderSet::from(vec![grok]);

        let built = instances.reconcile(&set, &Map::new()).await;
        assert_eq!(built, ["claudeAgent", "codex"]);
        assert_eq!(ids(&set), ["claudeAgent", "codex", "grok"]);

        // Orbit's effort instances, and a codex that is not installed.
        let with_low = settings(json!({"providerInstances": {
            "claudeLow": {"driver": "claudeAgent", "config": {"binaryPath": "/a/claude"}},
            "codex": {"driver": "codex", "config": {"binaryPath": "missing"}},
            "other": {"driver": "cursor"},
        }}));
        let before = set.get("claudeAgent").unwrap();
        let built = instances.reconcile(&set, &with_low).await;
        assert_eq!(built, ["codex", "claudeLow"]);
        assert_eq!(ids(&set), ["claudeAgent", "claudeLow", "grok"]);
        assert!(
            Arc::ptr_eq(&before, &set.get("claudeAgent").unwrap()),
            "unchanged: kept"
        );

        // Nothing changed: only the instance that is not offered is tried again.
        assert_eq!(instances.reconcile(&set, &with_low).await, ["codex"]);

        // A changed entry gives a new provider; a removed one is dropped.
        let changed = settings(json!({"providerInstances": {
            "claudeAgent": {"driver": "claudeAgent", "accentColor": "#123456"},
        }}));
        let built = instances.reconcile(&set, &changed).await;
        assert_eq!(built, ["claudeAgent", "codex"]);
        assert_eq!(ids(&set), ["claudeAgent", "codex", "grok"]);
        assert!(!Arc::ptr_eq(&before, &set.get("claudeAgent").unwrap()));
        assert_eq!(
            crate::lock(&instances.built).len(),
            2,
            "bounded by the instances"
        );
    }
}
