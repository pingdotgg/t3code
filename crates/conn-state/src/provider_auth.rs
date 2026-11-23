//! Provider sign-in: the `provider.auth.*` flow as a pure view model
//! (`ProviderAuthenticationSection.tsx`, `providerStatus.ts`).
//!
//! A client subscribes to `provider.auth.subscribe` and keeps the latest [`ProviderAuthState`]
//! as an [`AuthFlow`]; [`AuthPanel::derive`] says what the Account row shows and offers.

use conn_contract::{ProviderAuthState, ProviderAuthStatePhase, ServerProviderAuthStatus};
use serde_json::Value;

use crate::providers::ProviderGroup;

/// Something the sign-in flow waits for (`ProviderAuthInteraction`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AuthInteraction {
    /// Open `url` in a browser. `requires_consent` asks the server to record an `accept`
    /// first; `accepts_callback` lets the user paste the final `localhost` URL.
    Browser {
        id: String,
        url: String,
        requires_consent: bool,
        accepts_callback: bool,
    },
    /// Open `url` and enter `user_code`.
    DeviceCode {
        id: String,
        url: String,
        user_code: String,
    },
    /// A sign-in CLI in a terminal: its output so far.
    Terminal { id: String, output: String },
    Credentials {
        id: String,
        fields: Vec<CredentialField>,
    },
}

/// One input of a credentials interaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CredentialField {
    pub name: String,
    pub label: String,
    /// Mask the input.
    pub secret: bool,
}

/// A way to sign in (`ProviderAuthMethod`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthMethod {
    pub id: String,
    pub name: String,
}

/// The latest `provider.auth.subscribe` state of one instance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthFlow {
    pub instance_id: String,
    pub phase: ProviderAuthStatePhase,
    pub flow_id: Option<String>,
    pub authorization_url: Option<String>,
    pub message: Option<String>,
    /// `None` until the server lists them (an ACP agent discovers them).
    pub methods: Option<Vec<AuthMethod>>,
    pub interaction: Option<AuthInteraction>,
}

/// `isWebUrl`: the server supplies sign-in links and the client opens them, so a
/// `javascript:` or `file:` URL must never open.
#[must_use]
pub fn is_web_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://")
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_owned)
}

fn parse_interaction(value: &Value) -> Option<AuthInteraction> {
    let id = text(value, "id")?;
    match value.get("type")?.as_str()? {
        "browser" => Some(AuthInteraction::Browser {
            id,
            url: text(value, "url")?,
            requires_consent: value.get("requiresConsent")?.as_bool()?,
            accepts_callback: value
                .get("acceptsCallback")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }),
        "deviceCode" => Some(AuthInteraction::DeviceCode {
            id,
            url: text(value, "url")?,
            user_code: text(value, "userCode")?,
        }),
        "terminal" => Some(AuthInteraction::Terminal {
            id,
            output: text(value, "output").unwrap_or_default(),
        }),
        "credentials" => Some(AuthInteraction::Credentials {
            id,
            fields: value
                .get("fields")?
                .as_array()?
                .iter()
                .filter_map(|field| {
                    Some(CredentialField {
                        name: text(field, "name")?,
                        label: text(field, "label")?,
                        secret: field.get("secret").and_then(Value::as_bool).unwrap_or(true),
                    })
                })
                .collect(),
        }),
        // A newer server's interaction: the flow still shows its phase and message.
        _ => None,
    }
}

impl AuthFlow {
    /// Reads a `ProviderAuthState`.
    #[must_use]
    pub fn from_state(state: &ProviderAuthState) -> Self {
        Self {
            instance_id: state.instance_id.clone(),
            phase: state.phase,
            flow_id: state.flow_id.clone(),
            authorization_url: state.authorization_url.clone(),
            message: state.message.clone(),
            methods: state.methods.as_ref().map(|methods| {
                methods
                    .iter()
                    .flatten()
                    .map(|method| AuthMethod {
                        id: method.id.clone(),
                        name: method.name.clone(),
                    })
                    .collect()
            }),
            interaction: state.interaction.as_ref().and_then(parse_interaction),
        }
    }

    /// A flow is running: starting, waiting for the user, or verifying.
    #[must_use]
    pub fn active(&self) -> bool {
        matches!(
            self.phase,
            ProviderAuthStatePhase::Starting
                | ProviderAuthStatePhase::Waiting
                | ProviderAuthStatePhase::Verifying
        )
    }

    /// The link to open: the interaction's, else the flow's.
    #[must_use]
    pub fn url(&self) -> Option<&str> {
        match &self.interaction {
            Some(
                AuthInteraction::Browser { url, .. } | AuthInteraction::DeviceCode { url, .. },
            ) => Some(url),
            _ => self.authorization_url.as_deref(),
        }
    }
}

/// What the Account row of a provider shows and offers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthPanel {
    pub signed_in: bool,
    pub active: bool,
    /// The row's description line.
    pub description: String,
    /// A failed flow's message.
    pub status_message: Option<String>,
    /// Several ways to sign in: offer a choice, `Provider default` first.
    pub offers_method_choice: bool,
    /// The link to open or copy.
    pub url: Option<String>,
    /// The provider has no in-app sign-in: offer its documentation.
    pub offers_docs: bool,
    /// `Cancel` the running flow.
    pub offers_cancel: bool,
    /// The sign-in button's label, when it is offered.
    pub sign_in_label: Option<&'static str>,
    /// The sign-in button can be pressed.
    pub sign_in_enabled: bool,
    pub offers_sign_out: bool,
    /// Wait for the server to list sign-in methods.
    pub discovering: bool,
}

impl AuthPanel {
    /// `ProviderAuthenticationSection`'s decisions. `flow` is `None` until the first state
    /// arrives; `load_failed` is a subscription error.
    #[must_use]
    pub fn derive(
        provider: &ProviderGroup,
        flow: Option<&AuthFlow>,
        load_failed: bool,
        environment_label: &str,
    ) -> Self {
        let active = flow.is_some_and(AuthFlow::active);
        let phase = flow.map(|f| f.phase);
        let signed_in = provider.auth_status == ServerProviderAuthStatus::Authenticated
            || (provider.auth_status == ServerProviderAuthStatus::Unknown
                && phase == Some(ProviderAuthStatePhase::Succeeded));
        let methods = flow.and_then(|f| f.methods.as_ref());
        let is_acp = provider.driver == "acpRegistry";
        let discovering = is_acp && !active && !signed_in && !load_failed && methods.is_none();
        let needs_external_setup = !active
            && !signed_in
            && (provider.can_authenticate == Some(false)
                || (is_acp && methods.is_some_and(Vec::is_empty)));
        let uses_credentials = provider.driver == "antigravity"
            && matches!(
                provider.auth_type.as_deref(),
                Some("gemini-api-key" | "agent-platform")
            );
        let interaction = flow.and_then(|f| f.interaction.as_ref());
        let description = if active {
            match phase {
                Some(ProviderAuthStatePhase::Starting) => {
                    flow.and_then(|f| f.message.clone()).unwrap_or_else(|| {
                        if uses_credentials {
                            "Connecting\u{2026}".to_owned()
                        } else {
                            "Starting sign-in\u{2026}".to_owned()
                        }
                    })
                }
                Some(ProviderAuthStatePhase::Verifying) => if uses_credentials {
                    "Checking credentials and loading models\u{2026}"
                } else {
                    "Checking your account\u{2026}"
                }
                .to_owned(),
                _ => match interaction {
                    Some(AuthInteraction::Terminal { .. }) => {
                        "Complete sign-in in the terminal below.".to_owned()
                    }
                    Some(AuthInteraction::Credentials { .. }) => {
                        "Enter your credentials below.".to_owned()
                    }
                    _ => "Finish signing in in your browser.".to_owned(),
                },
            }
        } else if signed_in {
            "Signed in.".to_owned()
        } else if discovering {
            "Discovering sign-in methods\u{2026}".to_owned()
        } else if needs_external_setup {
            "No in-app sign-in advertised. Follow the provider's docs to finish setup.".to_owned()
        } else if uses_credentials {
            format!("Connect on {environment_label} to load models.")
        } else {
            format!("Sign in on {environment_label}.")
        };
        let failed = matches!(phase, Some(ProviderAuthStatePhase::Failed));
        let retry = failed || matches!(phase, Some(ProviderAuthStatePhase::Cancelled));
        let can_start =
            !active && !needs_external_setup && provider.can_authenticate != Some(false);
        let sign_in_label = can_start.then_some({
            if signed_in {
                "Change account"
            } else if retry {
                if uses_credentials {
                    "Retry connection"
                } else {
                    "Retry sign-in"
                }
            } else if uses_credentials {
                "Connect"
            } else {
                "Sign in"
            }
        });
        let offers_docs = needs_external_setup && provider.documentation_url.is_some();
        Self {
            signed_in,
            active,
            description,
            status_message: failed
                .then(|| flow.and_then(|f| f.message.clone()))
                .flatten(),
            offers_method_choice: !active && methods.is_some_and(|m| m.len() > 1),
            url: flow.and_then(|f| f.url()).map(str::to_owned),
            offers_docs,
            offers_cancel: !offers_docs && active && flow.is_some_and(|f| f.flow_id.is_some()),
            sign_in_label,
            sign_in_enabled: !load_failed
                && !discovering
                && provider.enabled
                && provider.installed
                && flow.is_some(),
            offers_sign_out: !active
                && signed_in
                && provider
                    .can_logout
                    .or(provider.can_authenticate)
                    .unwrap_or(false),
            discovering,
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

/// Strips ANSI escape sequences and carriage returns from a sign-in terminal's output, for a
/// client without a terminal emulator.
#[must_use]
pub fn plain_terminal_output(output: &str) -> String {
    let mut out = String::with_capacity(output.len());
    let mut chars = output.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.peek() {
                // CSI: parameters, then a final byte in `@`..`~`.
                Some('[') => {
                    chars.next();
                    for next in chars.by_ref() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                }
                // OSC: up to BEL or ST.
                Some(']') => {
                    chars.next();
                    while let Some(next) = chars.next() {
                        if next == '\u{7}' {
                            break;
                        }
                        if next == '\u{1b}' {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {
                    chars.next();
                }
            },
            '\r' => {
                if chars.peek() != Some(&'\n') {
                    out.push('\n');
                }
            }
            c if c.is_control() && c != '\n' && c != '\t' => {}
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::providers::ModelCatalog;

    fn group(overrides: &Value) -> ProviderGroup {
        let mut provider = json!({
            "instanceId": "antigravity", "driver": "antigravity", "enabled": true,
            "installed": true, "version": null, "status": "warning",
            "auth": { "status": "unauthenticated" },
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
    fn idle_antigravity_offers_sign_in() {
        let provider = group(&json!({}));
        let flow = state(&json!({
            "instanceId": "antigravity", "phase": "idle", "flowId": null,
            "authorizationUrl": null, "expiresAt": null, "message": null
        }));
        let panel = AuthPanel::derive(&provider, Some(&flow), false, "this Mac");
        assert_eq!(panel.description, "Sign in on this Mac.");
        assert_eq!(panel.sign_in_label, Some("Sign in"));
        assert!(panel.sign_in_enabled);
        assert!(!panel.signed_in && !panel.active && !panel.offers_sign_out);
    }

    #[test]
    fn browser_flow_shows_its_link_and_cancel() {
        let provider = group(&json!({}));
        let flow = state(&json!({
            "instanceId": "antigravity", "phase": "waiting", "flowId": "f1",
            "authorizationUrl": null, "expiresAt": null, "message": null,
            "interaction": {
                "type": "browser", "id": "i1", "url": "https://accounts.example/auth",
                "requiresConsent": true, "acceptsCallback": true
            }
        }));
        assert_eq!(
            flow.interaction,
            Some(AuthInteraction::Browser {
                id: "i1".into(),
                url: "https://accounts.example/auth".into(),
                requires_consent: true,
                accepts_callback: true
            })
        );
        let panel = AuthPanel::derive(&provider, Some(&flow), false, "this Mac");
        assert_eq!(panel.description, "Finish signing in in your browser.");
        assert_eq!(panel.url.as_deref(), Some("https://accounts.example/auth"));
        assert!(panel.offers_cancel && panel.sign_in_label.is_none());
    }

    #[test]
    fn credentials_flow_for_an_api_key_provider() {
        let provider =
            group(&json!({ "auth": { "status": "unauthenticated", "type": "gemini-api-key" } }));
        let flow = state(&json!({
            "instanceId": "antigravity", "phase": "waiting", "flowId": "f2",
            "authorizationUrl": null, "expiresAt": null, "message": null,
            "interaction": { "type": "credentials", "id": "i2",
                "fields": [{ "name": "apiKey", "label": "API key", "secret": true }] }
        }));
        let panel = AuthPanel::derive(&provider, Some(&flow), false, "this Mac");
        assert_eq!(panel.description, "Enter your credentials below.");
        assert!(matches!(
            flow.interaction,
            Some(AuthInteraction::Credentials { ref fields, .. }) if fields[0].secret
        ));
        let idle = AuthPanel::derive(&provider, None, false, "this Mac");
        assert_eq!(idle.sign_in_label, Some("Connect"));
        assert!(!idle.sign_in_enabled, "until the first state arrives");
    }

    #[test]
    fn signed_in_offers_change_account_and_sign_out() {
        let provider = group(&json!({ "auth": { "status": "authenticated", "email": "a@b.c" } }));
        let panel = AuthPanel::derive(&provider, None, false, "this Mac");
        assert!(panel.signed_in);
        assert_eq!(panel.description, "Signed in.");
        assert_eq!(panel.sign_in_label, Some("Change account"));
        assert!(panel.offers_sign_out);
        assert_eq!(provider.auth_email.as_deref(), Some("a@b.c"));
    }

    #[test]
    fn provider_without_in_app_sign_in_points_at_its_docs() {
        let provider = group(&json!({
            "driver": "codex", "instanceId": "codex",
            "setup": { "canAuthenticate": false, "canInstall": false, "documentationUrl": "https://docs.example" }
        }));
        let panel = AuthPanel::derive(&provider, None, false, "this Mac");
        assert!(panel.offers_docs && panel.sign_in_label.is_none());
        assert!(
            panel
                .description
                .starts_with("No in-app sign-in advertised.")
        );
    }

    #[test]
    fn failed_flow_keeps_its_message_and_offers_retry() {
        let provider = group(&json!({}));
        let flow = state(&json!({
            "instanceId": "antigravity", "phase": "failed", "flowId": null,
            "authorizationUrl": null, "expiresAt": null, "message": "Sign-in expired."
        }));
        let panel = AuthPanel::derive(&provider, Some(&flow), false, "this Mac");
        assert_eq!(panel.status_message.as_deref(), Some("Sign-in expired."));
        assert_eq!(panel.sign_in_label, Some("Retry sign-in"));
    }

    #[test]
    fn unknown_interactions_degrade_to_phase_and_message() {
        let flow = state(&json!({
            "instanceId": "x", "phase": "waiting", "flowId": "f", "authorizationUrl": null,
            "expiresAt": null, "message": null,
            "interaction": { "type": "hologram", "id": "i" }
        }));
        assert_eq!(flow.interaction, None);
        assert!(flow.active());
    }

    #[test]
    fn only_web_links_open() {
        assert!(is_web_url("https://example.com/a"));
        assert!(is_web_url(" HTTP://localhost:1455/cb"));
        assert!(!is_web_url("javascript:alert(1)"));
        assert!(!is_web_url("file:///etc/passwd"));
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

    #[test]
    fn terminal_output_loses_its_escape_codes() {
        assert_eq!(
            plain_terminal_output("\u{1b}[1mOpen\u{1b}[0m https://x.test\r\nCode: 1234\r"),
            "Open https://x.test\nCode: 1234\n"
        );
        assert_eq!(plain_terminal_output("\u{1b}]0;title\u{7}hi"), "hi");
    }
}
