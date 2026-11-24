//! A provider instance's `providerInstances[id]` envelope, as every driver reads it
//! (`ProviderInstanceConfig` in `packages/contracts`, `resolveProviderInstanceEnabled`,
//! `withInstanceIdentity` and `pathExpansion.ts` in `provider-core`).
//!
//! The instance environment may hold secrets: an entry marked `sensitive` lives in the
//! server's secret store, and the settings the server passes in carry its real value. So
//! [`InstanceEnv`] prints names only, never a value.

use serde_json::Value;

/// The instance's `environment` entries with a value, in order, `~` expanded where T3 expands
/// it. An entry whose secret was not resolved carries no value and is left out.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct InstanceEnv(pub Vec<(String, String)>);

impl std::fmt::Debug for InstanceEnv {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Values may be secrets: names only.
        f.debug_list()
            .entries(self.0.iter().map(|(name, _)| name))
            .finish()
    }
}

impl std::ops::Deref for InstanceEnv {
    type Target = [(String, String)];
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl InstanceEnv {
    /// The last value set for `name`.
    pub fn get(&self, name: &str) -> Option<&str> {
        self.0
            .iter()
            .rev()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    /// From the envelope's `environment` array, with [`expand_home_variable`].
    pub fn from_entries(entries: Option<&Value>) -> Self {
        let home = std::env::var_os("HOME").map(|h| h.to_string_lossy().into_owned());
        Self(
            entries
                .and_then(Value::as_array)
                .map(|vars| {
                    vars.iter()
                        .filter_map(|v| {
                            let name = v.get("name")?.as_str()?.to_owned();
                            let value = v.get("value")?.as_str()?;
                            let value = match &home {
                                Some(home) => expand_home_variable(&name, value, home),
                                None => value.to_owned(),
                            };
                            Some((name, value))
                        })
                        .collect()
                })
                .unwrap_or_default(),
        )
    }
}

impl From<Vec<(String, String)>> for InstanceEnv {
    fn from(entries: Vec<(String, String)>) -> Self {
        Self(entries)
    }
}

impl FromIterator<(String, String)> for InstanceEnv {
    fn from_iter<I: IntoIterator<Item = (String, String)>>(iter: I) -> Self {
        Self(iter.into_iter().collect())
    }
}

impl<'a> IntoIterator for &'a InstanceEnv {
    type Item = &'a (String, String);
    type IntoIter = std::slice::Iter<'a, (String, String)>;
    fn into_iter(self) -> Self::IntoIter {
        self.0.iter()
    }
}

/// The envelope fields every driver shares; `config` is the driver's own object. Its
/// `Debug` leaves `config` out: another driver's config may hold a secret.
#[derive(Clone, Default, PartialEq)]
pub struct InstanceEnvelope {
    /// `driver`, as stored.
    pub driver: Option<String>,
    pub enabled: bool,
    /// `displayName` and `accentColor`, trimmed (`withInstanceIdentity`).
    pub display_name: Option<String>,
    pub accent_color: Option<String>,
    pub environment: InstanceEnv,
    /// The driver's `config` object (`Null` when absent).
    pub config: Value,
}

impl std::fmt::Debug for InstanceEnvelope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InstanceEnvelope")
            .field("driver", &self.driver)
            .field("enabled", &self.enabled)
            .field("display_name", &self.display_name)
            .field("accent_color", &self.accent_color)
            .field("environment", &self.environment)
            .finish_non_exhaustive()
    }
}

/// A trimmed, non-empty string.
pub fn trimmed(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

impl InstanceEnvelope {
    /// From `providerInstances[id]` (`None`: the driver's default instance, unconfigured).
    /// `resolveProviderInstanceEnabled`: an explicit `false` on the envelope or in the config
    /// wins; then the envelope, then the config, then the driver's default.
    pub fn parse(entry: Option<&Value>, default_enabled: bool) -> Self {
        let Some(entry) = entry else {
            return Self {
                enabled: default_enabled,
                config: Value::Null,
                ..Self::default()
            };
        };
        let config = entry.get("config").cloned().unwrap_or(Value::Null);
        let envelope_enabled = entry.get("enabled").and_then(Value::as_bool);
        let config_enabled = config.get("enabled").and_then(Value::as_bool);
        let enabled = if envelope_enabled == Some(false) || config_enabled == Some(false) {
            false
        } else {
            envelope_enabled
                .or(config_enabled)
                .unwrap_or(default_enabled)
        };
        Self {
            driver: entry
                .get("driver")
                .and_then(Value::as_str)
                .map(str::to_owned),
            enabled,
            display_name: entry.get("displayName").and_then(trimmed),
            accent_color: entry.get("accentColor").and_then(trimmed),
            environment: InstanceEnv::from_entries(entry.get("environment")),
            config,
        }
    }

    /// A string field of `config`, trimmed; `None` when empty or absent.
    pub fn config_str(&self, key: &str) -> Option<String> {
        self.config.get(key).and_then(trimmed)
    }
}

pub use conn_support::home::{HOME_PATH_VARIABLES, expand_home_path, expand_home_variable};

/// `expandHomePath` with the process's `HOME`; unchanged without one.
pub fn expand_home(value: &str) -> String {
    match std::env::var_os("HOME") {
        Some(home) => expand_home_path(value, &home.to_string_lossy()),
        None => value.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_enabled_rule() {
        assert!(InstanceEnvelope::parse(None, true).enabled);
        assert!(!InstanceEnvelope::parse(None, false).enabled);
        let e = |v| InstanceEnvelope::parse(Some(&v), true).enabled;
        assert!(!e(json!({"enabled": false})));
        assert!(!e(json!({"enabled": true, "config": {"enabled": false}})));
        assert!(e(json!({"driver": "claudeAgent"})));
        assert!(!InstanceEnvelope::parse(Some(&json!({})), false).enabled);
        assert!(
            InstanceEnvelope::parse(Some(&json!({"config": {"enabled": true}})), false).enabled
        );
    }

    #[test]
    fn debug_never_prints_a_value() {
        let envelope = InstanceEnvelope::parse(
            Some(&json!({"environment": [
                {"name": "KEY", "value": "s3cret-value", "sensitive": true},
                {"name": "UNRESOLVED", "sensitive": true}
            ]})),
            true,
        );
        assert_eq!(envelope.environment.0.len(), 1);
        let printed = format!("{envelope:?}");
        assert!(
            printed.contains("KEY") && !printed.contains("s3cret-value"),
            "{printed}"
        );
    }
}
