//! The T3 home, as `apps/server/src/config.ts` lays it out: `$T3CODE_HOME` (default `~/.t3`)
//! with server state in `userdata/`. This server claims the state directory with the same
//! lock the TypeScript server takes (`server-owner.sqlite`), so the two never run on one home,
//! and publishes `server-runtime.json` so the CLI finds the running server.

use std::{
    fs, io,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::auth::{iso8601, now_ms, write_atomic};

/// `SERVER_EXIT_CODE_STATE_DIR_OWNED`: Conn desktop stops restarting a backend that exits so.
pub const EXIT_STATE_DIR_OWNED: i32 = 78;

/// Where state lives. `--state-dir` names it directly; otherwise it is `<home>/userdata`, the
/// home being `--base-dir`, `$T3CODE_HOME`, or `~/.t3`. `$CONN_SERVER_HOME` (the spike's
/// variable) still names a state directory when nothing else is set.
/// Fails only when nothing names a folder: no flag, no `$T3CODE_HOME` and no `$HOME`.
pub fn resolve_state_dir(
    state_dir: Option<PathBuf>,
    base_dir: Option<PathBuf>,
) -> Result<PathBuf, String> {
    resolve_state_dir_with(state_dir, base_dir, |name| std::env::var_os(name))
}

fn resolve_state_dir_with(
    state_dir: Option<PathBuf>,
    base_dir: Option<PathBuf>,
    var: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> Result<PathBuf, String> {
    if let Some(dir) = state_dir {
        return Ok(dir);
    }
    let env = |name| var(name).filter(|v| !v.is_empty()).map(PathBuf::from);
    if let Some(home) = base_dir.or_else(|| env("T3CODE_HOME")) {
        return Ok(expand_tilde(home, env("HOME")).join("userdata"));
    }
    if let Some(dir) = env("CONN_SERVER_HOME") {
        return Ok(dir);
    }
    let home = env("HOME")
        .ok_or("no state folder: set HOME or T3CODE_HOME, or pass --state-dir or --base-dir")?;
    Ok(home.join(".t3").join("userdata"))
}

fn expand_tilde(path: PathBuf, home: Option<PathBuf>) -> PathBuf {
    match (path.strip_prefix("~"), home) {
        (Ok(rest), Some(home)) => home.join(rest),
        _ => path,
    }
}

/// Holds the state directory until dropped: an exclusive transaction on `server-owner.sqlite`,
/// which the OS releases when the process ends, even on SIGKILL.
pub struct Ownership {
    _lock: rusqlite::Connection,
}

#[derive(Debug)]
pub enum OwnershipError {
    /// Another server (this one or the TypeScript one) runs on this state directory.
    Owned,
    Io(String),
}

pub fn acquire_ownership(state_dir: &Path) -> Result<Ownership, OwnershipError> {
    fs::create_dir_all(state_dir).map_err(|e| OwnershipError::Io(e.to_string()))?;
    let path = state_dir.join("server-owner.sqlite");
    let connection =
        rusqlite::Connection::open(&path).map_err(|e| OwnershipError::Io(e.to_string()))?;
    match connection.execute_batch("PRAGMA busy_timeout = 250; BEGIN EXCLUSIVE;") {
        Ok(()) => Ok(Ownership { _lock: connection }),
        Err(rusqlite::Error::SqliteFailure(error, _))
            if matches!(
                error.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            ) =>
        {
            Err(OwnershipError::Owned)
        }
        Err(error) => Err(OwnershipError::Io(error.to_string())),
    }
}

/// `PersistedServerRuntimeState` (`serverRuntimeState.ts`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeState {
    pub version: u32,
    pub pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    pub port: u16,
    pub origin: String,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_version: Option<String>,
}

fn runtime_path(state_dir: &Path) -> PathBuf {
    state_dir.join("server-runtime.json")
}

impl RuntimeState {
    /// The state of this process listening on `host:port`. A wildcard host is reached
    /// at `127.0.0.1`.
    pub fn new(host: &str, port: u16, owner_id: String) -> Self {
        let reach = match host {
            "0.0.0.0" | "::" | "[::]" | "" => "127.0.0.1".to_owned(),
            h if h.contains(':') && !h.starts_with('[') => format!("[{h}]"),
            h => h.to_owned(),
        };
        Self {
            version: 1,
            pid: std::process::id(),
            owner_id: Some(owner_id),
            host: Some(host.to_owned()),
            port,
            origin: format!("http://{reach}:{port}"),
            started_at: iso8601(now_ms()),
            server_version: Some(crate::environment::CONTRACT_SERVER_VERSION.into()),
        }
    }

    pub fn publish(&self, state_dir: &Path) -> io::Result<()> {
        let mut text = serde_json::to_string(self).expect("runtime state serializes");
        text.push('\n');
        write_atomic(&runtime_path(state_dir), text.as_bytes(), 0o644)
    }

    /// Removes the file if it is still this server's.
    pub fn clear(&self, state_dir: &Path) {
        if read_runtime_state(state_dir).is_some_and(|s| s.owner_id == self.owner_id) {
            let _ = fs::remove_file(runtime_path(state_dir));
        }
    }
}

/// The running server's state, if a live process published one.
pub fn read_runtime_state(state_dir: &Path) -> Option<RuntimeState> {
    let text = fs::read_to_string(runtime_path(state_dir)).ok()?;
    let state: RuntimeState = serde_json::from_str(text.trim()).ok()?;
    process_alive(state.pid).then_some(state)
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    // `kill -0` without libc: /proc on Linux, `ps` elsewhere.
    if Path::new("/proc/self").exists() {
        return Path::new(&format!("/proc/{pid}")).exists();
    }
    std::process::Command::new("ps")
        .args(["-p", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[cfg(not(unix))]
fn process_alive(_pid: u32) -> bool {
    true
}

/// `projects.json`: folders added with `project add`, offered as projects at every start.
pub fn read_projects(state_dir: &Path) -> Vec<(PathBuf, String)> {
    let Ok(text) = fs::read_to_string(state_dir.join("projects.json")) else {
        return Vec::new();
    };
    let Ok(Value::Array(entries)) = serde_json::from_str::<Value>(&text) else {
        eprintln!("conn-server: ignoring malformed projects.json");
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|e| {
            Some((
                PathBuf::from(e["workspaceRoot"].as_str()?),
                e["title"].as_str()?.to_owned(),
            ))
        })
        .collect()
}

/// Adds or retitles a project in `projects.json`.
pub fn add_project(state_dir: &Path, root: &Path, title: &str) -> io::Result<()> {
    let mut projects = read_projects(state_dir);
    projects.retain(|(r, _)| r != root);
    projects.push((root.to_owned(), title.to_owned()));
    let entries: Vec<Value> = projects
        .iter()
        .map(|(root, title)| json!({ "workspaceRoot": root, "title": title }))
        .collect();
    let mut text = serde_json::to_string_pretty(&entries).expect("projects serialize");
    text.push('\n');
    write_atomic(&state_dir.join("projects.json"), text.as_bytes(), 0o644)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("conn-home-{}", crate::auth::random_hex(6)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_missing_home_is_an_error_not_a_panic() {
        let none = |_: &str| None;
        assert!(resolve_state_dir_with(None, None, none).is_err());
        assert_eq!(
            resolve_state_dir_with(Some("/s".into()), None, none),
            Ok(PathBuf::from("/s"))
        );
        let home = |name: &str| (name == "HOME").then(|| "/home/u".into());
        assert_eq!(
            resolve_state_dir_with(None, None, home),
            Ok(PathBuf::from("/home/u/.t3/userdata"))
        );
        assert_eq!(
            resolve_state_dir_with(None, Some("~/t3".into()), home),
            Ok(PathBuf::from("/home/u/t3/userdata"))
        );
    }

    #[test]
    fn one_server_owns_a_state_directory() {
        let dir = temp_dir();
        let first = acquire_ownership(&dir).unwrap();
        assert!(matches!(
            acquire_ownership(&dir),
            Err(OwnershipError::Owned)
        ));
        drop(first);
        assert!(acquire_ownership(&dir).is_ok());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_runtime_state_names_a_live_server_only() {
        let dir = temp_dir();
        let state = RuntimeState::new("0.0.0.0", 3773, "owner".into());
        assert_eq!(state.origin, "http://127.0.0.1:3773");
        state.publish(&dir).unwrap();
        assert_eq!(read_runtime_state(&dir), Some(state.clone()));
        let mut dead = state.clone();
        dead.pid = 999_999_999;
        dead.publish(&dir).unwrap();
        assert_eq!(read_runtime_state(&dir), None);
        state.publish(&dir).unwrap();
        state.clear(&dir);
        assert!(!runtime_path(&dir).exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn projects_are_added_once_per_folder() {
        let dir = temp_dir();
        add_project(&dir, Path::new("/srv/workspace"), "One").unwrap();
        add_project(&dir, Path::new("/srv/other"), "Two").unwrap();
        add_project(&dir, Path::new("/srv/workspace"), "Renamed").unwrap();
        assert_eq!(
            read_projects(&dir),
            vec![
                (PathBuf::from("/srv/other"), "Two".to_owned()),
                (PathBuf::from("/srv/workspace"), "Renamed".to_owned()),
            ]
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_state_directory_follows_t3_home() {
        assert_eq!(
            resolve_state_dir(Some("/s".into()), Some("/b".into())),
            Ok(PathBuf::from("/s"))
        );
        assert_eq!(
            resolve_state_dir(None, Some("/b".into())),
            Ok(PathBuf::from("/b/userdata"))
        );
    }
}
