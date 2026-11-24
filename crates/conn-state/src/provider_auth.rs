//! Antigravity's credential check: the one provider sign-in Conn keeps, as a pure view model
//! (`ProviderAuthenticationSection.tsx`, `providerStatus.ts`).
//!
//! Providers run through the Orbit AI router (`docs/scope.md` §2 #3, #4), so there is no
//! browser, device-code, callback or credential-form sign-in and no sign-out. Antigravity with a
//! `gemini-api-key` or `agent-platform` method checks the credentials its settings hold:
//! `provider.auth.start` runs the check, `provider.auth.cancel` stops it, and a client follows
//! `provider.auth.subscribe` as an [`AuthFlow`]. [`AuthPanel::derive`] says what the row shows.

use conn_contract::{ProviderAuthState, ProviderAuthStatePhase, ServerProviderAuthStatus};

use crate::providers::ProviderGroup;

/// The latest `provider.auth.subscribe` state of one instance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthFlow {
    pub instance_id: String,
    pub phase: ProviderAuthStatePhase,
    pub flow_id: Option<String>,
    pub message: Option<String>,
}

impl AuthFlow {
    /// Reads a `ProviderAuthState`.
    #[must_use]
    pub fn from_state(state: &ProviderAuthState) -> Self {
        Self {
            instance_id: state.instance_id.clone(),
            phase: state.phase,
            flow_id: state.flow_id.clone(),
            message: state.message.clone(),
        }
    }

    /// A check is running: starting, waiting or verifying.
    #[must_use]
    pub fn active(&self) -> bool {
        matches!(
            self.phase,
            ProviderAuthStatePhase::Starting
                | ProviderAuthStatePhase::Waiting
                | ProviderAuthStatePhase::Verifying
        )
    }
}

/// Whether `provider` offers the credential check: Antigravity, where the server says it can
/// check (`setup.canAuthenticate`, only for its credential methods).
#[must_use]
pub fn offers_credential_check(provider: &ProviderGroup) -> bool {
    provider.driver == "antigravity" && provider.can_authenticate == Some(true)
}

/// What the credential-check row shows and offers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthPanel {
    /// The server reports the credentials work.
    pub connected: bool,
    pub active: bool,
    /// The row's description line.
    pub description: String,
    /// A failed check's message.
    pub status_message: Option<String>,
    /// `Cancel` the running check.
    pub offers_cancel: bool,
    /// The start button's label, when it is offered.
    pub connect_label: Option<&'static str>,
    /// The start button can be pressed.
    pub connect_enabled: bool,
}

impl AuthPanel {
    /// `flow` is `None` until the first state arrives; `load_failed` is a subscription error.
    #[must_use]
    pub fn derive(
        provider: &ProviderGroup,
        flow: Option<&AuthFlow>,
        load_failed: bool,
        environment_label: &str,
    ) -> Self {
        let active = flow.is_some_and(AuthFlow::active);
        let phase = flow.map(|f| f.phase);
        let connected = provider.auth_status == ServerProviderAuthStatus::Authenticated
            || (provider.auth_status == ServerProviderAuthStatus::Unknown
                && phase == Some(ProviderAuthStatePhase::Succeeded));
        let message = flow.and_then(|f| f.message.clone());
        let description = if active {
            match phase {
                Some(ProviderAuthStatePhase::Verifying) => {
                    "Checking credentials and loading models\u{2026}".to_owned()
                }
                _ => message
                    .clone()
                    .unwrap_or_else(|| "Connecting\u{2026}".to_owned()),
            }
        } else if connected {
            "Connected.".to_owned()
        } else {
            format!("Connect on {environment_label} to load models.")
        };
        let failed = phase == Some(ProviderAuthStatePhase::Failed);
        let retry = failed || phase == Some(ProviderAuthStatePhase::Cancelled);
        let connect_label = (!active).then_some(if connected {
            "Check again"
        } else if retry {
            "Retry connection"
        } else {
            "Connect"
        });
        Self {
            connected,
            active,
            description,
            status_message: failed.then_some(message).flatten(),
            offers_cancel: active && flow.is_some_and(|f| f.flow_id.is_some()),
            connect_label,
            connect_enabled: !load_failed
                && provider.enabled
                && provider.installed
                && flow.is_some(),
        }
    }
}

/// The colour of a provider's status dot (`getProviderStatusKey`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatusKey {
    Disabled,
    Neutral,
    Error,
    Ready,
    Warning,
}

/// A provider's one-line status (`getProviderSummary`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderSummary {
    pub key: StatusKey,
    pub headline: String,
    pub detail: Option<String>,
}

/// Antigravity's local health check verifies installation, not Google sign-in. API-key and Agent
/// Platform warnings still need attention.
fn antigravity_sign_in_unchecked(provider: &ProviderGroup) -> bool {
    provider.driver == "antigravity"
        && provider.installed
        && provider.status == conn_contract::ServerProviderState::Warning
        && provider.auth_status == ServerProviderAuthStatus::Unknown
        && matches!(
            provider.auth_type.as_deref(),
            None | Some("oauth-personal" | "oauth-business")
        )
}

/// `providerAuthLabel`.
fn auth_label(provider: &ProviderGroup) -> Option<String> {
    if provider.auth_type.as_deref() == Some("customEndpoint") {
        return Some("Custom API endpoint".to_owned());
    }
    provider
        .auth_label
        .clone()
        .or_else(|| provider.auth_type.clone())
}

impl ProviderSummary {
    /// `getProviderSummary` and `getProviderStatusKey` for one provider.
    #[must_use]
    pub fn of(provider: &ProviderGroup) -> Self {
        use conn_contract::ServerProviderState as State;
        let message = provider.message.clone();
        let unchecked = antigravity_sign_in_unchecked(provider);
        let key = if !provider.enabled {
            StatusKey::Disabled
        } else if unchecked {
            StatusKey::Neutral
        } else {
            match provider.status {
                State::Ready => StatusKey::Ready,
                State::Warning => StatusKey::Warning,
                State::Error => StatusKey::Error,
                State::Disabled => StatusKey::Disabled,
            }
        };
        let (headline, detail) = if !provider.enabled || provider.status == State::Disabled {
            (
                "Disabled".to_owned(),
                Some(message.unwrap_or_else(|| {
                    "This provider is installed but disabled for new sessions in Conn.".to_owned()
                })),
            )
        } else if !provider.installed {
            (
                "Not found".to_owned(),
                Some(message.unwrap_or_else(|| "CLI not detected on PATH.".to_owned())),
            )
        } else if provider.auth_status == ServerProviderAuthStatus::Unauthenticated {
            (
                auth_label(provider).map_or_else(
                    || "Not authenticated".to_owned(),
                    |label| format!("Not authenticated \u{b7} {label}"),
                ),
                message,
            )
        } else if unchecked {
            ("Installed \u{b7} Sign-in not checked".to_owned(), message)
        } else if provider.status == State::Warning {
            (
                "Needs attention".to_owned(),
                Some(message.unwrap_or_else(|| {
                    "The provider is installed, but the server could not fully verify it."
                        .to_owned()
                })),
            )
        } else if provider.status == State::Error {
            (
                "Unavailable".to_owned(),
                Some(
                    message.unwrap_or_else(|| "The provider failed its startup checks.".to_owned()),
                ),
            )
        } else if provider.auth_status == ServerProviderAuthStatus::Authenticated {
            (
                auth_label(provider).map_or_else(
                    || "Authenticated".to_owned(),
                    |label| format!("Authenticated \u{b7} {label}"),
                ),
                message,
            )
        } else {
            ("Available".to_owned(), message)
        };
        Self {
            key,
            headline,
            detail,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;
    use crate::providers::ModelCatalog;

    fn group(overrides: &Value) -> ProviderGroup {
        let mut provider = json!({
            "instanceId": "antigravity", "driver": "antigravity", "enabled": true,
            "installed": true, "version": null, "status": "warning",
            "auth": { "status": "unauthenticated", "type": "gemini-api-key" },
            "checkedAt": "2026-11-21T00:00:00Z",
            "models": [{ "slug": "m", "name": "M", "isCustom": false, "capabilities": null }],
            "setup": { "canAuthenticate": true, "canInstall": false }
        });
        if let (Some(base), Some(extra)) = (provider.as_object_mut(), overrides.as_object()) {
            base.extend(extra.clone());
        }
        let item = serde_json::from_value(provider).expect("provider decodes");
        ModelCatalog::from_providers(&[Some(item)])
            .providers
            .remove(0)
    }

    fn state(value: &Value) -> AuthFlow {
        AuthFlow::from_state(&serde_json::from_value(value.clone()).expect("state decodes"))
    }

    #[test]
    fn only_antigravity_with_a_credential_method_offers_the_check() {
        assert!(offers_credential_check(&group(&json!({}))));
        let google = group(&json!({ "setup": { "canAuthenticate": false, "canInstall": false } }));
        assert!(!offers_credential_check(&google));
        let codex = group(&json!({ "driver": "codex", "instanceId": "codex" }));
        assert!(
            !offers_credential_check(&codex),
            "providers sign in through the AI router"
        );
    }

    #[test]
    fn idle_check_offers_connect_once_the_first_state_arrives() {
        let provider = group(&json!({}));
        let idle = AuthPanel::derive(&provider, None, false, "this Mac");
        assert_eq!(idle.connect_label, Some("Connect"));
        assert!(!idle.connect_enabled, "until the first state arrives");
        let flow = state(&json!({
            "instanceId": "antigravity", "phase": "idle", "flowId": null,
            "authorizationUrl": null, "expiresAt": null, "message": null
        }));
        let panel = AuthPanel::derive(&provider, Some(&flow), false, "this Mac");
        assert_eq!(panel.description, "Connect on this Mac to load models.");
        assert!(panel.connect_enabled && !panel.connected && !panel.active);
    }

    #[test]
    fn a_running_check_shows_its_progress_and_cancel() {
        let provider = group(&json!({}));
        let flow = state(&json!({
            "instanceId": "antigravity", "phase": "waiting", "flowId": "f1",
            "authorizationUrl": null, "expiresAt": null, "message": "Checking the API key\u{2026}"
        }));
        let panel = AuthPanel::derive(&provider, Some(&flow), false, "this Mac");
        assert_eq!(panel.description, "Checking the API key\u{2026}");
        assert!(panel.offers_cancel && panel.connect_label.is_none());
    }

    #[test]
    fn a_failed_check_keeps_its_message_and_offers_retry() {
        let provider = group(&json!({}));
        let flow = state(&json!({
            "instanceId": "antigravity", "phase": "failed", "flowId": null,
            "authorizationUrl": null, "expiresAt": null, "message": "The API key was refused."
        }));
        let panel = AuthPanel::derive(&provider, Some(&flow), false, "this Mac");
        assert_eq!(
            panel.status_message.as_deref(),
            Some("The API key was refused.")
        );
        assert_eq!(panel.connect_label, Some("Retry connection"));
    }

    #[test]
    fn working_credentials_read_connected() {
        let provider =
            group(&json!({ "auth": { "status": "authenticated", "type": "gemini-api-key" } }));
        let panel = AuthPanel::derive(&provider, None, false, "this Mac");
        assert!(panel.connected);
        assert_eq!(panel.description, "Connected.");
        assert_eq!(panel.connect_label, Some("Check again"));
    }

    #[test]
    fn summaries_follow_conn() {
        let unchecked = group(
            &json!({ "auth": { "status": "unknown" }, "message": "Google account access is not checked yet." }),
        );
        let summary = ProviderSummary::of(&unchecked);
        assert_eq!(summary.key, StatusKey::Neutral);
        assert_eq!(summary.headline, "Installed \u{b7} Sign-in not checked");

        let signed_out =
            group(&json!({ "auth": { "status": "unauthenticated", "label": "Google" } }));
        assert_eq!(
            ProviderSummary::of(&signed_out).headline,
            "Not authenticated \u{b7} Google"
        );

        let off = group(&json!({ "enabled": false, "status": "disabled" }));
        let summary = ProviderSummary::of(&off);
        assert_eq!(
            (summary.key, summary.headline.as_str()),
            (StatusKey::Disabled, "Disabled")
        );

        let missing = group(&json!({ "installed": false }));
        assert_eq!(ProviderSummary::of(&missing).headline, "Not found");
    }
}
