//! A host's saved settings, read from the server's settings as stored (secrets included).
//!
//! `ServerSettings.sourceControlHosts.<kind>` holds each host's fields
//! (`readSourceControlHostSettings` with the host's schema). A credential field is a
//! `SettingsSecretValue`: a literal, or a `{provider, reference}` that a secret provider holds.
//! This server resolves no secret provider, so a reference reads as the T3 server's
//! `SettingsSecretUnresolvedError`.

use serde_json::{Map, Value};

use crate::secret::Secret;

/// The server's settings as stored. Cheap to clone a view out of; the caller owns the map.
#[derive(Clone, Debug, Default)]
pub struct Settings {
    root: Map<String, Value>,
}

impl Settings {
    pub fn new(root: Map<String, Value>) -> Self {
        Self { root }
    }

    /// `sourceControlHosts.<kind>`, or an empty object.
    pub fn host(&self, kind: &str) -> HostSettings<'_> {
        HostSettings {
            fields: self
                .root
                .get("sourceControlHosts")
                .and_then(|h| h.get(kind))
                .and_then(Value::as_object),
            secret_providers: self.root.get("secretProviders").and_then(Value::as_object),
        }
    }
}

/// One host kind's settings.
#[derive(Clone, Copy, Debug)]
pub struct HostSettings<'a> {
    fields: Option<&'a Map<String, Value>>,
    secret_providers: Option<&'a Map<String, Value>>,
}

/// A credential field's value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SecretSetting {
    Unset,
    Literal(Secret),
    /// A secret reference this server cannot read; the label names its provider.
    Unresolved {
        provider: String,
    },
}

impl SecretSetting {
    /// `requireSettingsSecretLiteral`: the literal (`None` when blank), or the unresolved error's
    /// message.
    pub fn require(&self) -> Result<Option<Secret>, String> {
        match self {
            SecretSetting::Unset => Ok(None),
            SecretSetting::Literal(secret) => Ok(Some(secret.clone())),
            SecretSetting::Unresolved { provider } => Err(format!(
                "Could not read the credential from the secret provider \"{provider}\". Unlock or fix it in Settings, then try again."
            )),
        }
    }
}

impl<'a> HostSettings<'a> {
    fn field(&self, name: &str) -> Option<&'a Value> {
        self.fields.and_then(|f| f.get(name))
    }

    fn secret(&self, value: Option<&Value>) -> SecretSetting {
        match value {
            Some(Value::String(text)) => Secret::non_empty(text.as_str())
                .map_or(SecretSetting::Unset, SecretSetting::Literal),
            Some(Value::Object(reference)) => {
                let provider = reference
                    .get("provider")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let label = self
                    .secret_providers
                    .and_then(|p| p.get(provider))
                    .and_then(|p| p.get("label"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|l| !l.is_empty());
                SecretSetting::Unresolved {
                    provider: label.unwrap_or(provider).to_owned(),
                }
            }
            _ => SecretSetting::Unset,
        }
    }

    /// A plain credential field (Bitbucket's `accessToken`, GitCafe's `token`).
    pub fn secret_field(&self, name: &str) -> SecretSetting {
        self.secret(self.field(name))
    }

    /// One host's entry of a keyed credential field (GitHub's `tokens`, `signIns`).
    pub fn keyed_secret(&self, name: &str, host: &str) -> SecretSetting {
        self.secret(self.field(name).and_then(|m| m.get(host)))
    }

    /// A plain text field, trimmed (Bitbucket's `email`).
    pub fn text(&self, name: &str) -> String {
        self.field(name)
            .and_then(Value::as_str)
            .map(|s| s.trim().to_owned())
            .unwrap_or_default()
    }

    /// `hosts[host].enabled` (default true), from `hostCredentialSettingsFields`.
    pub fn host_enabled(&self, host: &str) -> bool {
        self.field("hosts")
            .and_then(|h| h.get(host))
            .and_then(|h| h.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(true)
    }

    /// `hosts[host].account`, the account chosen in Settings.
    pub fn host_account(&self, host: &str) -> Option<&'a str> {
        self.field("hosts")
            .and_then(|h| h.get(host))
            .and_then(|h| h.get("account"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|a| !a.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_literals_references_and_defaults() {
        let settings = Settings::new(
            serde_json::from_str(
                r#"{"secretProviders":{"op":{"label":" 1Password "}},
                    "sourceControlHosts":{"github":{
                      "tokens":{"github.com":"  ghp_x ","ghe.example":{"provider":"op","reference":"r"}},
                      "hosts":{"github.com":{"enabled":false,"account":" me "}}}}}"#,
            )
            .expect("json"),
        );
        let github = settings.host("github");
        assert_eq!(
            github
                .keyed_secret("tokens", "github.com")
                .require()
                .expect("literal")
                .map(|s| s.expose().to_owned()),
            Some("ghp_x".to_owned()),
            "trimmed literal"
        );
        assert_eq!(
            github.keyed_secret("tokens", "ghe.example").require(),
            Err("Could not read the credential from the secret provider \"1Password\". Unlock or fix it in Settings, then try again.".to_owned()),
            "a reference names its provider's label"
        );
        assert!(!github.host_enabled("github.com"), "disabled");
        assert!(github.host_enabled("other"), "enabled by default");
        assert_eq!(github.host_account("github.com"), Some("me"), "account");
        assert_eq!(
            settings.host("gitlab").secret_field("token"),
            SecretSetting::Unset,
            "unset"
        );
    }
}
