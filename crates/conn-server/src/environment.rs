//! The environment this server is: its stable id, its descriptor, where it keeps state, and
//! the stores clients configure it through (settings, keybindings, access).
//!
//! The state directory has the layout of the TypeScript server's (`<T3 home>/userdata`), so a
//! home moves between the two: `environment-id`, `settings.json` and `keybindings.json` are
//! shared files in the same format. See `DROP-IN.md` for the rest.

use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::Arc,
};

use conn_contract::{
    ExecutionEnvironmentCapabilities, ExecutionEnvironmentCapabilitiesFileAttachments,
    ExecutionEnvironmentDescriptor, ExecutionEnvironmentPlatform, ExecutionEnvironmentPlatformArch,
    ExecutionEnvironmentPlatformOs, ServerConfig,
};
use serde_json::{Value, json};

use crate::{
    auth::{self, AuthStore},
    http::ORCHESTRATION_PROTOCOL_VERSION,
    keybindings::KeybindingsStore,
    settings::SettingsStore,
};

/// The `apps/server` version at the pinned Conn commit (generated into `conn-contract`).
/// Clients compare it with their own version; a lower one shows a "server is behind" hint. The
/// Codex provider sends the same value in `initialize`, as the T3 server does.
pub const CONTRACT_SERVER_VERSION: &str = conn_contract::T3_SERVER_VERSION;

pub struct Environment {
    /// `ExecutionEnvironmentDescriptor`, served at `/.well-known/t3/environment` and inside
    /// the server config.
    pub descriptor: Value,
    pub cwd: PathBuf,
    pub state_dir: PathBuf,
    pub settings: SettingsStore,
    pub keybindings: KeybindingsStore,
    /// Sessions and pairing links (`auth.json`).
    pub auth: Arc<AuthStore>,
}

impl Environment {
    /// Reads the environment id from `state_dir`, or creates one on first start, and opens
    /// the stores. `cwd` is the folder the server reports as its own.
    pub fn load(state_dir: &Path, label: Option<String>, cwd: PathBuf) -> io::Result<Self> {
        fs::create_dir_all(state_dir)?;
        let environment_id = load_or_create_id(&state_dir.join("environment-id"))?;
        let label = label
            .or_else(|| std::env::var("HOSTNAME").ok())
            .or_else(hostname)
            .filter(|l| !l.trim().is_empty())
            .unwrap_or_else(|| "conn-server".into());
        Ok(Self {
            descriptor: descriptor(&environment_id, label.trim()),
            cwd,
            state_dir: state_dir.to_owned(),
            settings: SettingsStore::open(state_dir.join("settings.json")),
            keybindings: KeybindingsStore::open(state_dir.join("keybindings.json")),
            auth: AuthStore::open(state_dir.join("auth.json"))?,
        })
    }

    pub fn environment_id(&self) -> &str {
        self.descriptor["environmentId"]
            .as_str()
            .unwrap_or_default()
    }
}

/// `ServerEnvironment.ts`: a UUID and a newline. The TypeScript server's file is read as is,
/// so a home keeps its identity, and clients their pairing records, across the switch.
fn load_or_create_id(file: &Path) -> io::Result<String> {
    match fs::read_to_string(file) {
        Ok(id) if !id.trim().is_empty() => Ok(id.trim().to_owned()),
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "empty environment-id",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let id = auth::random_uuid();
            // `create_new` so two processes starting at once cannot both write one.
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(file)
            {
                Ok(mut handle) => {
                    io::Write::write_all(&mut handle, format!("{id}\n").as_bytes())?;
                    Ok(id)
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    Ok(fs::read_to_string(file)?.trim().to_owned())
                }
                Err(error) => Err(error),
            }
        }
        Err(error) => Err(error),
    }
}

/// The machine's name, as `os.hostname()` gives the T3 server its label.
fn hostname() -> Option<String> {
    fs::read_to_string("/etc/hostname")
        .ok()
        .or_else(|| {
            let out = std::process::Command::new("hostname")
                .arg("-s")
                .output()
                .ok()?;
            out.status
                .success()
                .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
        })
        .map(|h| h.trim().to_owned())
}

/// `ExecutionEnvironmentDescriptor`, built from the contract type, so a new required field
/// upstream is a compile error here.
pub fn descriptor(environment_id: &str, label: &str) -> Value {
    conn_contract::to_json(&ExecutionEnvironmentDescriptor {
        environment_id: environment_id.into(),
        label: label.into(),
        platform: ExecutionEnvironmentPlatform {
            os: os(),
            arch: arch(),
            machine: None,
        },
        server_version: CONTRACT_SERVER_VERSION.into(),
        orchestration_protocol_version: Some(i64::from(ORCHESTRATION_PROTOCOL_VERSION)),
        database_migration: None,
        capabilities: capabilities(),
        orbit_instance: None,
    })
}

/// The one place for what this server advertises. A capability promises a behaviour that
/// clients then rely on, so each one here is served; every other one stays unset (off). This
/// covers the descriptor's `capabilities` and the flags `ServerConfig` carries
/// ([`config_flags`]).
pub fn capabilities() -> ExecutionEnvironmentCapabilities {
    // Every capability is optional; the test below proves this decode holds.
    let mut capabilities: ExecutionEnvironmentCapabilities =
        conn_contract::from_json(json!({})).expect("every capability is optional");
    capabilities.repository_identity = Some(false);
    // Uploads are claimed by the message that sends them (`host.rs`).
    capabilities.attachment_uploads = Some(true);
    capabilities.file_attachments = Some(ExecutionEnvironmentCapabilitiesFileAttachments {
        max_upload_bytes: i64::try_from(conn_files::attachments::MAX_FILE_BYTES)
            .unwrap_or(i64::MAX),
    });
    capabilities.thread_force_stop = Some(true);
    capabilities.shell_thread_families = Some(true);
    capabilities.shell_older_settled = Some(true);
    // projects.listIgnoredFiles, with `query` (conn-files entries::list_ignored).
    capabilities.ignored_file_listing = Some(true);
    capabilities.ignored_file_search = Some(true);
    capabilities
}

/// The `ServerConfig` flags this server serves: the engine answers getThreadFamily,
/// getOlderSettledThreads, getThreadLinkMetadata and searchThread.
pub fn config_flags(config: &mut ServerConfig) {
    config.shell_thread_families = Some(true);
    config.shell_older_settled = Some(true);
    config.thread_link_metadata = Some(true);
    config.thread_find = Some(true);
}

fn os() -> ExecutionEnvironmentPlatformOs {
    match std::env::consts::OS {
        "macos" => ExecutionEnvironmentPlatformOs::Darwin,
        "linux" => ExecutionEnvironmentPlatformOs::Linux,
        "windows" => ExecutionEnvironmentPlatformOs::Windows,
        _ => ExecutionEnvironmentPlatformOs::Unknown,
    }
}

fn arch() -> ExecutionEnvironmentPlatformArch {
    match std::env::consts::ARCH {
        "aarch64" => ExecutionEnvironmentPlatformArch::Arm64,
        "x86_64" => ExecutionEnvironmentPlatformArch::X64,
        _ => ExecutionEnvironmentPlatformArch::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_typescript_servers_environment_id() {
        let dir = std::env::temp_dir().join(format!("conn-env-{}", auth::random_hex(6)));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("environment-id"),
            "0b6f1a52-3c1e-4d7a-9a55-2a1f8b0c9d10\n",
        )
        .unwrap();
        let env = Environment::load(&dir, Some("Box".into()), dir.clone()).unwrap();
        assert_eq!(env.environment_id(), "0b6f1a52-3c1e-4d7a-9a55-2a1f8b0c9d10");
        let fresh = dir.join("fresh");
        let made = Environment::load(&fresh, None, dir.clone()).unwrap();
        assert_eq!(made.environment_id().len(), 36);
        assert_eq!(
            fs::read_to_string(fresh.join("environment-id")).unwrap(),
            format!("{}\n", made.environment_id())
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_descriptor_decodes_and_advertises_only_what_is_served() {
        let descriptor = descriptor("0b6f1a52-3c1e-4d7a-9a55-2a1f8b0c9d10", "Box");
        let typed: ExecutionEnvironmentDescriptor =
            conn_contract::from_json(descriptor.clone()).unwrap();
        assert_eq!(typed.server_version, conn_contract::T3_SERVER_VERSION);
        let advertised: Vec<&String> = descriptor["capabilities"]
            .as_object()
            .unwrap()
            .iter()
            .filter(|(_, v)| *v != &Value::Bool(false))
            .map(|(k, _)| k)
            .collect();
        assert_eq!(
            advertised,
            [
                "attachmentUploads",
                "fileAttachments",
                "ignoredFileListing",
                "ignoredFileSearch",
                "shellOlderSettled",
                "shellThreadFamilies",
                "threadForceStop"
            ]
        );
    }
}
