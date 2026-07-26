//! Serde mirror of `DesktopBackendBootstrap` from
//! `packages/contracts/src/desktopBootstrap.ts`.
//!
//! Field names, optionality, and JSON shape must match the TS `Schema.Struct`
//! exactly — the Node server decodes this exact schema off the bootstrap file
//! descriptor (see `apps/server/src/bootstrap.ts` +
//! `apps/server/src/cli/config.ts`).
//!
//! `skip_serializing_if = "Option::is_none"` omits the key entirely when the
//! value is absent, matching the TS side's `Schema.optional(...)`, which
//! serializes an `undefined` field as a missing key rather than `null`. This
//! is the same rule `apps/mac/Sources/SidecarKit/BootstrapEnvelope.swift`
//! encodes with `encodeIfPresent`.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rand::RngCore as _;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BootstrapEnvelope {
    /// Always "desktop" — the only literal the TS schema accepts.
    pub mode: String,
    pub port: u16,
    #[serde(rename = "t3Home", skip_serializing_if = "Option::is_none")]
    pub t3_home: Option<String>,
    pub host: String,
    #[serde(rename = "desktopBootstrapToken")]
    pub desktop_bootstrap_token: String,
    #[serde(rename = "tailscaleServeEnabled")]
    pub tailscale_serve_enabled: bool,
    #[serde(rename = "tailscaleServePort")]
    pub tailscale_serve_port: u16,
    #[serde(rename = "otlpTracesUrl", skip_serializing_if = "Option::is_none")]
    pub otlp_traces_url: Option<String>,
    #[serde(rename = "otlpMetricsUrl", skip_serializing_if = "Option::is_none")]
    pub otlp_metrics_url: Option<String>,
}

impl BootstrapEnvelope {
    pub fn new(
        port: u16,
        t3_home: Option<String>,
        host: impl Into<String>,
        desktop_bootstrap_token: impl Into<String>,
        tailscale_serve_enabled: bool,
        tailscale_serve_port: u16,
    ) -> Self {
        Self {
            mode: "desktop".to_owned(),
            port,
            t3_home,
            host: host.into(),
            desktop_bootstrap_token: desktop_bootstrap_token.into(),
            tailscale_serve_enabled,
            tailscale_serve_port,
            otlp_traces_url: None,
            otlp_metrics_url: None,
        }
    }

    /// Encodes the envelope as a single line of JSON (no trailing newline),
    /// suitable for writing to the server's `--bootstrap-fd` stream. The
    /// server only ever reads one line off the bootstrap fd
    /// (`readBootstrapEnvelope`), so the caller appends its own `\n` and then
    /// closes stdin.
    pub fn encode_line(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }
}

/// Generates the desktop bootstrap token exchanged for a session/bearer token
/// by the local HTTP auth API (`desktop-managed-local` policy). 32 bytes (256
/// bits) of CSPRNG output, base64url encoded (RFC 4648 §5) without padding —
/// the same shape and margin as the macOS `BootstrapTokenGenerator`.
pub fn generate_bootstrap_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn omits_absent_optional_keys() {
        let envelope = BootstrapEnvelope::new(3773, None, "127.0.0.1", "tok", false, 443);
        let line = envelope.encode_line().expect("encodes");
        assert!(!line.contains("t3Home"));
        assert!(!line.contains("otlpTracesUrl"));
        assert!(!line.contains("otlpMetricsUrl"));
        assert!(!line.contains('\n'));
    }

    #[test]
    fn uses_the_wire_field_names() {
        let envelope = BootstrapEnvelope::new(
            3773,
            Some("C:\\Users\\a\\AppData\\Roaming\\SergeCode".to_owned()),
            "127.0.0.1",
            "tok",
            true,
            443,
        );
        let value: serde_json::Value =
            serde_json::from_str(&envelope.encode_line().expect("encodes")).expect("parses");
        assert_eq!(value["mode"], "desktop");
        assert_eq!(value["port"], 3773);
        assert_eq!(value["desktopBootstrapToken"], "tok");
        assert_eq!(value["tailscaleServeEnabled"], true);
        assert_eq!(value["tailscaleServePort"], 443);
        assert!(value["t3Home"].is_string());
    }

    #[test]
    fn token_is_url_safe_and_unpadded() {
        let token = generate_bootstrap_token();
        // 32 bytes -> 43 base64 characters with no padding.
        assert_eq!(token.len(), 43);
        assert!(!token.contains('='));
        assert!(!token.contains('+'));
        assert!(!token.contains('/'));
        assert_ne!(token, generate_bootstrap_token());
    }
}
