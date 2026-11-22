//! Desktop-only local file persistence for Orbit sessions and profile sync snapshots.
//!
//! Kept in `conn-desktop` (not `conn-orbit`) because paths target macOS Application Support /
//! XDG config dirs (`~/Library/Application Support/conn-gpui/`) and `CONN_GPUI_CONFIG_DIR`.
//! On iOS, bearer tokens and snapshots belong in Keychain / the app sandbox container instead.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use conn_orbit::{OrbitSyncPrefs, OrbitWorkspace, SectionMeta};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Cached bearer token for one paired Orbit Node or Instance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedOrbitSession {
    pub server_id: String,
    pub url: String,
    pub label: String,
    pub bearer: String,
    pub paired_at_unix: i64,
}

/// Persistent local store of auto-paired `conn-server` bearer tokens for Orbit Nodes/Instances.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrbitSessionStore {
    #[serde(default)]
    pub active_server_id: Option<String>,
    #[serde(default)]
    pub sessions: BTreeMap<String, CachedOrbitSession>,
}

impl OrbitSessionStore {
    /// Default path (`~/Library/Application Support/conn-gpui/orbit-sessions.json` on macOS),
    /// overridable with `CONN_GPUI_CONFIG_DIR` for isolated dev/test sessions.
    #[must_use]
    pub fn default_path() -> Option<PathBuf> {
        if let Some(dir) = std::env::var_os("CONN_GPUI_CONFIG_DIR") {
            return Some(PathBuf::from(dir).join("orbit-sessions.json"));
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
        Some(dir.join("orbit-sessions.json"))
    }

    /// Loads the store from disk, returning empty defaults if missing or unreadable.
    #[must_use]
    pub fn load_from(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    /// Loads from the default application support path.
    #[must_use]
    pub fn load_default() -> Self {
        Self::default_path()
            .map(|p| Self::load_from(&p))
            .unwrap_or_default()
    }

    /// Saves atomically to `path` (mode `0600` on Unix since it stores bearer tokens).
    ///
    /// # Errors
    /// Returns any filesystem I/O or serialization error encountered while writing.
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

    /// Saves to the default application support path.
    ///
    /// # Errors
    /// Returns [`std::io::ErrorKind::NotFound`] if `HOME` is unset, or any write error.
    pub fn save_default(&self) -> std::io::Result<()> {
        let Some(path) = Self::default_path() else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "HOME directory not set",
            ));
        };
        self.save_to(&path)
    }

    /// Returns a cached bearer token for `server_id`, when present.
    #[must_use]
    pub fn bearer_for(&self, server_id: &str) -> Option<&str> {
        self.sessions
            .get(server_id)
            .map(|s| s.bearer.as_str())
            .filter(|t| !t.is_empty())
    }

    /// Records a newly paired bearer token for `server_id` and marks it active.
    pub fn record_bearer(
        &mut self,
        server_id: impl Into<String>,
        url: impl Into<String>,
        label: impl Into<String>,
        bearer: impl Into<String>,
    ) {
        let server_id = server_id.into();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX));
        self.active_server_id = Some(server_id.clone());
        self.sessions.insert(
            server_id.clone(),
            CachedOrbitSession {
                server_id,
                url: url.into(),
                label: label.into(),
                bearer: bearer.into(),
                paired_at_unix: now,
            },
        );
    }

    /// Clears a cached bearer token (e.g. after a 401/Auth failure so next attempt re-pairs).
    pub fn remove_bearer(&mut self, server_id: &str) {
        self.sessions.remove(server_id);
    }
}

/// Local desktop snapshot persisted across launches so 3-way conflict merges have a known `base`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct OrbitSyncSnapshot {
    pub profile_id: Option<i64>,
    pub profile_version: i64,
    pub workspaces: Vec<OrbitWorkspace>,
    pub appearance_version: i64,
    pub appearance_base: Option<Map<String, Value>>,
    #[serde(default)]
    pub appearance_meta: Option<SectionMeta>,
    pub desktop_version: i64,
    pub desktop_base: Option<Map<String, Value>>,
    #[serde(default)]
    pub desktop_meta: Option<SectionMeta>,
    /// Local backup taken right before "Use the profile" replaces device settings.
    #[serde(default)]
    pub appearance_backup: Option<Map<String, Value>>,
    #[serde(default)]
    pub desktop_backup: Option<Map<String, Value>>,
    #[serde(default)]
    pub backup_saved_at_unix: Option<i64>,
    pub prefs: OrbitSyncPrefs,
}

impl OrbitSyncSnapshot {
    /// Default config file location (`~/Library/Application Support/conn-gpui/orbit-profile.json`),
    /// overridable with `CONN_GPUI_CONFIG_DIR` for isolated dev/test sessions.
    #[must_use]
    pub fn default_path() -> Option<PathBuf> {
        if let Some(dir) = std::env::var_os("CONN_GPUI_CONFIG_DIR") {
            return Some(PathBuf::from(dir).join("orbit-profile.json"));
        }
        let home = std::env::var_os("HOME")?;
        Some(
            PathBuf::from(home)
                .join("Library/Application Support/conn-gpui")
                .join("orbit-profile.json"),
        )
    }

    /// Loads the saved snapshot from `path`, returning `Default` when missing or unreadable.
    #[must_use]
    pub fn load_from(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    /// Persists the snapshot atomically to `path`.
    ///
    /// # Errors
    /// Returns any filesystem I/O or serialization error encountered while writing.
    pub fn save_to(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json)?;
        std::fs::rename(tmp, path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_store_roundtrips_bearer_tokens() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("orbit-sessions.json");
        let mut store = OrbitSessionStore::default();
        store.record_bearer("node-beast", "http://10.44.0.7:3773", "beast", "tok-secret");
        store.save_to(&path).expect("save");

        let loaded = OrbitSessionStore::load_from(&path);
        assert_eq!(loaded.active_server_id.as_deref(), Some("node-beast"));
        assert_eq!(loaded.bearer_for("node-beast"), Some("tok-secret"));
    }

    #[test]
    fn deserializes_legacy_orbit_sessions() {
        let legacy_sessions_json = serde_json::json!({
            "active_server_id": "node-nick",
            "sessions": {
                "node-nick": {
                    "server_id": "node-nick",
                    "url": "http://10.44.0.6:3773",
                    "label": "nick",
                    "bearer": "legacy-token",
                    "paired_at_unix": 1_700_000_000
                }
            }
        })
        .to_string();
        let store: OrbitSessionStore =
            serde_json::from_str(&legacy_sessions_json).expect("legacy orbit-sessions.json");
        assert_eq!(store.active_server_id.as_deref(), Some("node-nick"));
        assert_eq!(store.bearer_for("node-nick"), Some("legacy-token"));
    }

    #[test]
    fn snapshot_round_trips_to_disk() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("orbit-profile.json");
        let snap = OrbitSyncSnapshot {
            profile_id: Some(42),
            profile_version: 9,
            workspaces: vec![OrbitWorkspace {
                id: "w1".to_owned(),
                name: "Conn".to_owned(),
                color: "#3b82f6".to_owned(),
                icon: None,
                image: None,
                project_refs: Vec::new(),
                project_keys: Vec::new(),
            }],
            ..OrbitSyncSnapshot::default()
        };
        snap.save_to(&path).expect("save snapshot");
        let loaded = OrbitSyncSnapshot::load_from(&path);
        assert_eq!(loaded, snap);
    }
}
