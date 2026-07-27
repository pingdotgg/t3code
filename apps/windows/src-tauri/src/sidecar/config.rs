//! Everything the supervisor needs to spawn and watch one t3 server child:
//! binary location, argv-relevant values, and where its logs go.
//!
//! Windows counterpart of `apps/mac/Sources/SidecarKit/SidecarConfig.swift`.
//! The only behavioural differences are path shapes: the data directory lives
//! under `%APPDATA%\SergeCode` instead of
//! `~/Library/Application Support/SergeCode`, and the packaged server payload
//! is resolved from the Tauri resource directory instead of an
//! `.app` bundle's `Contents/Resources`.

use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};
use std::path::{Path, PathBuf};

/// Path of the bundled server entry relative to the resource directory.
/// Kept in sync with `apps/windows/scripts/stage-sidecar.mjs`.
pub const BUNDLED_ENTRY_RESOURCE_PATH: &str = "SergeCodeServer/bin.mjs";

/// Path of the bundled Node runtime relative to the resource directory.
pub const BUNDLED_NODE_RESOURCE_PATH: &str = "SergeCodeNode/node.exe";

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("could not pick a free loopback port: {0}")]
    PortPick(#[source] std::io::Error),
    #[error("could not resolve the application data directory")]
    NoDataDirectory,
}

/// Picks an available loopback TCP port by binding to port 0 (letting the OS
/// assign one), reading it back, then closing the socket. There is an inherent
/// TOCTOU race between closing this probe socket and the child binding the
/// same port — acceptable for a local supervisor where nothing else on the
/// machine is aggressively racing for ports. Same tradeoff as the macOS
/// `FreePortPicker`.
pub fn pick_free_port(host: Ipv4Addr) -> Result<u16, ConfigError> {
    let listener = TcpListener::bind(SocketAddrV4::new(host, 0)).map_err(ConfigError::PortPick)?;
    let port = listener.local_addr().map_err(ConfigError::PortPick)?.port();
    drop(listener);
    Ok(port)
}

/// `%APPDATA%\SergeCode` — a dedicated native-app state directory, distinct
/// from any other server installation's.
pub fn default_base_dir() -> Result<PathBuf, ConfigError> {
    dirs::data_dir()
        .map(|dir| dir.join("SergeCode"))
        .ok_or(ConfigError::NoDataDirectory)
}

/// The bundled server entry inside the installed app, or `None` when the
/// resource directory does not embed one (dev builds).
pub fn bundled_entry_path(resource_dir: Option<&Path>) -> Option<PathBuf> {
    let candidate = resource_dir?.join(BUNDLED_ENTRY_RESOURCE_PATH);
    candidate.is_file().then_some(candidate)
}

/// The bundled Node runtime, or `None` for dev builds. The staged runtime is
/// version-pinned by `stage-sidecar.mjs`, so callers skip the version probe
/// entirely when this resolves.
pub fn bundled_node_path(resource_dir: Option<&Path>) -> Option<PathBuf> {
    let candidate = resource_dir?.join(BUNDLED_NODE_RESOURCE_PATH);
    candidate.is_file().then_some(candidate)
}

/// Walks up from `start` looking for `apps/server/dist/bin.mjs`, mirroring the
/// macOS dev-checkout resolver. Only meaningful for local checkouts.
pub fn dev_entry_path(start: &Path) -> Option<PathBuf> {
    let mut current = Some(start);
    for _ in 0..12 {
        let dir = current?;
        let candidate = dir.join("apps").join("server").join("dist").join("bin.mjs");
        if candidate.is_file() {
            return Some(candidate);
        }
        current = dir.parent();
    }
    None
}

#[derive(Debug, Clone)]
pub struct SidecarConfig {
    pub node_path: PathBuf,
    pub entry_path: PathBuf,
    pub port: u16,
    pub host: String,
    pub base_dir: PathBuf,
    pub log_directory: PathBuf,
    /// Whether the server should attempt `tailscale serve`. Sent in the
    /// bootstrap envelope, where it OVERRIDES the server's own default — so
    /// the app must always pass its preference explicitly.
    pub tailscale_serve_enabled: bool,
    pub tailscale_serve_port: u16,
}

impl SidecarConfig {
    pub fn new(
        node_path: PathBuf,
        entry_path: PathBuf,
        host: String,
        base_dir: Option<PathBuf>,
        tailscale_serve_enabled: bool,
    ) -> Result<Self, ConfigError> {
        let base_dir = match base_dir {
            Some(dir) => dir,
            None => default_base_dir()?,
        };
        let log_directory = base_dir.join("logs").join("sidecar");
        // A wildcard bind is not a connectable address, so the port probe
        // always goes through loopback regardless of the requested bind host.
        let port = pick_free_port(Ipv4Addr::LOCALHOST)?;
        Ok(Self {
            node_path,
            entry_path,
            port,
            host,
            base_dir,
            log_directory,
            tailscale_serve_enabled,
            tailscale_serve_port: 443,
        })
    }

    /// The address the app itself connects to. `0.0.0.0` (LAN access enabled
    /// for the mobile companion) is not connectable, so probe loopback.
    pub fn probe_host(&self) -> &str {
        match self.host.as_str() {
            "0.0.0.0" | "::" | "[::]" => "127.0.0.1",
            other => other,
        }
    }

    pub fn readiness_url(&self) -> String {
        format!(
            "http://{}:{}/.well-known/t3/environment",
            self.probe_host(),
            self.port
        )
    }

    pub fn http_base_url(&self) -> String {
        format!("http://{}:{}", self.probe_host(), self.port)
    }

    pub fn ws_base_url(&self) -> String {
        format!("ws://{}:{}", self.probe_host(), self.port)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_a_bindable_loopback_port() {
        let port = pick_free_port(Ipv4Addr::LOCALHOST).expect("picks a port");
        assert!(port > 0);
        // The probe socket is closed, so the port must be re-bindable.
        TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).expect("rebinds");
    }

    #[test]
    fn wildcard_binds_probe_over_loopback() {
        let config = SidecarConfig {
            node_path: PathBuf::from("node.exe"),
            entry_path: PathBuf::from("bin.mjs"),
            port: 3773,
            host: "0.0.0.0".to_owned(),
            base_dir: PathBuf::from("C:\\base"),
            log_directory: PathBuf::from("C:\\base\\logs"),
            tailscale_serve_enabled: false,
            tailscale_serve_port: 443,
        };
        assert_eq!(config.probe_host(), "127.0.0.1");
        assert_eq!(
            config.readiness_url(),
            "http://127.0.0.1:3773/.well-known/t3/environment"
        );
        assert_eq!(config.ws_base_url(), "ws://127.0.0.1:3773");
    }

    #[test]
    fn missing_bundled_resources_resolve_to_none() {
        assert!(bundled_entry_path(None).is_none());
        assert!(bundled_node_path(Some(Path::new("/definitely/not/here"))).is_none());
    }
}
