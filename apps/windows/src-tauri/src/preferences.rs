//! Launch-time preferences that must be known *before* the sidecar is
//! spawned, because they are fixed for the lifetime of the child process.
//!
//! The bind host and the bootstrap envelope are decided at spawn (see
//! `ARCHITECTURE.md`, "Sidecar contract"), so toggling either of these in
//! Settings only takes effect on the next launch — the same rule the macOS
//! app documents for `MobileAccessPreference` / `TailscaleAccessPreference`.
//!
//! macOS stores these in `UserDefaults`. Windows has no equivalent
//! app-scoped store that a Rust process can read before the webview exists,
//! so they live in a small JSON file next to the server's own state.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::window::Backdrop;

const FILE_NAME: &str = "windows-app.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LaunchPreferences {
    /// Bind `0.0.0.0` instead of loopback so the iPhone companion can reach
    /// this machine over the LAN. Flips the server's auth policy to
    /// `remote-reachable`.
    pub allow_lan_access: bool,
    /// Ask the server to expose itself over the tailnet via `tailscale serve`.
    pub tailscale_serve_enabled: bool,
    /// Which DWM system backdrop the main window composites over.
    pub backdrop: Backdrop,
}

impl Default for LaunchPreferences {
    fn default() -> Self {
        Self {
            allow_lan_access: false,
            // The macOS app defaults this ON; parity keeps a paired iPhone
            // reachable after a Windows reinstall without re-toggling.
            tailscale_serve_enabled: true,
            backdrop: Backdrop::MicaAlt,
        }
    }
}

impl LaunchPreferences {
    pub fn path(base_dir: &Path) -> PathBuf {
        base_dir.join(FILE_NAME)
    }

    /// Reads the preferences file, falling back to defaults for a missing or
    /// unreadable file. A malformed file must never block launch.
    pub fn load(base_dir: &Path) -> Self {
        let Ok(contents) = std::fs::read_to_string(Self::path(base_dir)) else {
            return Self::default();
        };
        serde_json::from_str(&contents).unwrap_or_default()
    }

    pub fn save(&self, base_dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(base_dir)?;
        let contents = serde_json::to_string_pretty(self)?;
        std::fs::write(Self::path(base_dir), contents)
    }

    /// The host the sidecar binds. Wildcard only when LAN access is on.
    pub fn bind_host(&self) -> &'static str {
        if self.allow_lan_access {
            "0.0.0.0"
        } else {
            "127.0.0.1"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("sergecode-prefs-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn defaults_bind_loopback_with_tailscale_on() {
        let preferences = LaunchPreferences::default();
        assert_eq!(preferences.bind_host(), "127.0.0.1");
        assert!(preferences.tailscale_serve_enabled);
        assert!(!preferences.allow_lan_access);
    }

    #[test]
    fn lan_access_switches_to_the_wildcard_bind() {
        let preferences = LaunchPreferences {
            allow_lan_access: true,
            ..LaunchPreferences::default()
        };
        assert_eq!(preferences.bind_host(), "0.0.0.0");
    }

    #[test]
    fn missing_and_malformed_files_fall_back_to_defaults() {
        let dir = temp_dir("missing");
        assert_eq!(LaunchPreferences::load(&dir), LaunchPreferences::default());

        std::fs::create_dir_all(&dir).expect("creates dir");
        std::fs::write(LaunchPreferences::path(&dir), "{ not json").expect("writes");
        assert_eq!(LaunchPreferences::load(&dir), LaunchPreferences::default());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn round_trips_through_the_file() {
        let dir = temp_dir("roundtrip");
        let preferences = LaunchPreferences {
            allow_lan_access: true,
            tailscale_serve_enabled: false,
            backdrop: Backdrop::Acrylic,
        };
        preferences.save(&dir).expect("saves");
        assert_eq!(LaunchPreferences::load(&dir), preferences);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn partial_files_keep_defaults_for_absent_keys() {
        let dir = temp_dir("partial");
        std::fs::create_dir_all(&dir).expect("creates dir");
        std::fs::write(LaunchPreferences::path(&dir), r#"{"allowLanAccess": true}"#)
            .expect("writes");
        let loaded = LaunchPreferences::load(&dir);
        assert!(loaded.allow_lan_access);
        assert!(loaded.tailscale_serve_enabled);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
