//! Persistence and URL/pairing parsing for direct `conn-server` connections.
//!
//! Lets the user connect `conn-gpui` directly to any local or remote `conn-server` (via a
//! `pairingUrl` like `http://127.0.0.1:3780/pair#token=...` or a base URL + bearer token) and
//! automatically reconnect on the next launch. Stored with `0600` permissions in
//! `~/Library/Application Support/conn-gpui/server.json` (overridable via `CONN_GPUI_CONFIG_DIR`).

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use url::Url;

/// Parsed user input from the Settings → Connections "Connect to conn-server" form.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParsedServerInput {
    /// Single-use pairing URL (`http://host:port/pair#token=CODE`).
    Pairing {
        http_base_url: Url,
        pairing_code: String,
    },
    /// Base URL + bearer access token.
    Bearer { http_base_url: Url, bearer: String },
}

/// Persisted direct `conn-server` session (bearer token exchanged from a pairing URL or pasted
/// directly).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedServerConfig {
    pub url: String,
    #[serde(default)]
    pub label: Option<String>,
    pub bearer: String,
    #[serde(default)]
    pub updated_at_unix: i64,
}

impl SavedServerConfig {
    /// Default path (`~/Library/Application Support/conn-gpui/server.json` on macOS),
    /// overridable with `CONN_GPUI_CONFIG_DIR`.
    #[must_use]
    pub fn default_path() -> Option<PathBuf> {
        if let Some(dir) = std::env::var_os("CONN_GPUI_CONFIG_DIR") {
            return Some(PathBuf::from(dir).join("server.json"));
        }
        let home = std::env::var_os("HOME").map(PathBuf::from)?;
        #[cfg(target_os = "macos")]
        let dir = home
            .join("Library")
            .join("Application Support")
            .join("conn-gpui");
        #[cfg(not(target_os = "macos"))]
        let dir = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"))
            .join("conn-gpui");
        Some(dir.join("server.json"))
    }

    /// Loads the saved server config from `path`, returning `None` if missing or invalid.
    #[must_use]
    pub fn load_from(path: &Path) -> Option<Self> {
        let raw = std::fs::read_to_string(path).ok()?;
        let parsed: Self = serde_json::from_str(&raw).ok()?;
        if parsed.url.trim().is_empty() || parsed.bearer.trim().is_empty() {
            return None;
        }
        Some(parsed)
    }

    /// Loads the saved server config from the default path.
    #[must_use]
    pub fn load_default() -> Option<Self> {
        Self::default_path().and_then(|p| Self::load_from(&p))
    }

    /// Saves atomically to `path` with mode `0600` on Unix.
    ///
    /// # Errors
    ///
    /// Returns an I/O error if the directory cannot be created or the file cannot be written.
    pub fn save_to(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let payload = serde_json::to_string_pretty(self)
            .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, payload)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(&tmp, path)
    }

    /// Saves to the default path.
    ///
    /// # Errors
    ///
    /// Returns an I/O error if `HOME` is unset or saving fails.
    pub fn save_default(&self) -> std::io::Result<()> {
        let Some(path) = Self::default_path() else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "HOME directory not set",
            ));
        };
        self.save_to(&path)
    }

    /// Removes the saved server file from the default path, if present.
    pub fn clear_default() {
        if let Some(path) = Self::default_path() {
            let _ = std::fs::remove_file(path);
        }
    }

    /// Builds a new [`SavedServerConfig`] stamped with the current Unix timestamp.
    #[must_use]
    pub fn new(url: impl Into<String>, label: Option<String>, bearer: impl Into<String>) -> Self {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX));
        Self {
            url: url.into(),
            label,
            bearer: bearer.into(),
            updated_at_unix: now,
        }
    }
}

/// Parses a user-entered `conn-server` pairing URL or server URL + bearer token.
///
/// Accepts:
/// - Full pairing URL (`http://127.0.0.1:3780/pair#token=CODE`)
/// - Server URL (`http://127.0.0.1:3780`, or bare `127.0.0.1:3780`) paired with a non-empty
///   `bearer_token`.
///
/// # Errors
///
/// Returns a user-facing error message when the URL is invalid or credentials are missing.
pub fn parse_server_input(
    raw_url: &str,
    bearer_token: Option<&str>,
) -> Result<ParsedServerInput, String> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return Err("Enter a conn-server URL or pairing URL.".to_owned());
    }
    let normalized = if trimmed.contains("://") {
        trimmed.to_owned()
    } else {
        format!("http://{trimmed}")
    };
    let parsed = Url::parse(&normalized).map_err(|err| format!("Invalid server URL: {err}"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("Server URL must use http:// or https:// with a valid host.".to_owned());
    }

    let mut base = parsed.clone();
    base.set_path("/");
    base.set_query(None);
    base.set_fragment(None);

    if let Some(code) = parsed
        .fragment()
        .and_then(|frag| frag.strip_prefix("token="))
        .map(str::trim)
        .filter(|c| !c.is_empty())
    {
        return Ok(ParsedServerInput::Pairing {
            http_base_url: base,
            pairing_code: code.to_owned(),
        });
    }

    let token = bearer_token
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| {
            "Paste a pairing URL (#token=...) or enter a bearer token from `conn-server auth session issue --token-only`."
                .to_owned()
        })?;

    Ok(ParsedServerInput::Bearer {
        http_base_url: base,
        bearer: token.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pairing_url_and_normalizes_base() {
        let parsed = parse_server_input("http://127.0.0.1:3780/pair#token=abc123", None)
            .expect("pairing url should parse");
        assert_eq!(
            parsed,
            ParsedServerInput::Pairing {
                http_base_url: Url::parse("http://127.0.0.1:3780/").expect("valid base"),
                pairing_code: "abc123".to_owned(),
            }
        );
    }

    #[test]
    fn parses_bare_host_with_bearer_token() {
        let parsed = parse_server_input("127.0.0.1:3780", Some("  tok-xyz  "))
            .expect("bare host + bearer should parse");
        assert_eq!(
            parsed,
            ParsedServerInput::Bearer {
                http_base_url: Url::parse("http://127.0.0.1:3780/").expect("valid base"),
                bearer: "tok-xyz".to_owned(),
            }
        );
    }

    #[test]
    fn rejects_url_without_token_or_pairing_fragment() {
        let err = parse_server_input("http://127.0.0.1:3780", None);
        assert!(err.is_err(), "missing token must fail cleanly");
    }

    #[test]
    fn saved_server_config_round_trips() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("server.json");
        let saved = SavedServerConfig::new(
            "http://127.0.0.1:3780/",
            Some("Local conn-server".to_owned()),
            "secret-bearer",
        );
        saved.save_to(&path).expect("save_to");
        let loaded = SavedServerConfig::load_from(&path).expect("load_from");
        assert_eq!(loaded, saved, "round-trip config must match");
    }
}
