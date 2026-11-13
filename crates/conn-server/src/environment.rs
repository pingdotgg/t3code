//! The environment this server is: its stable id, its descriptor, where it keeps state.

use std::{
    fs, io,
    path::{Path, PathBuf},
};

use serde_json::{Value, json};

use crate::{auth, http::ORCHESTRATION_PROTOCOL_VERSION};

/// The `apps/server` version at the pinned contract commit. Clients compare it with their
/// own version; a lower one shows a "server is behind" hint.
pub const CONTRACT_SERVER_VERSION: &str = "0.1.9";

pub struct Environment {
    /// `ExecutionEnvironmentDescriptor`, served at `/.well-known/t3/environment` and inside
    /// the server config.
    pub descriptor: Value,
    pub cwd: PathBuf,
    pub state_dir: PathBuf,
}

impl Environment {
    /// Reads the environment id from `state_dir`, or creates one on first start.
    pub fn load(state_dir: &Path, label: Option<String>) -> io::Result<Self> {
        fs::create_dir_all(state_dir)?;
        let id_file = state_dir.join("environment-id");
        let environment_id = match fs::read_to_string(&id_file) {
            Ok(id) if !id.trim().is_empty() => id.trim().to_owned(),
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "empty environment-id",
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let id = auth::random_hex(16);
                fs::write(&id_file, &id)?;
                id
            }
            Err(error) => return Err(error),
        };
        let label = label
            .or_else(|| std::env::var("HOSTNAME").ok())
            .filter(|l| !l.trim().is_empty())
            .unwrap_or_else(|| "conn-server".into());
        Ok(Self {
            descriptor: descriptor(&environment_id, label.trim()),
            cwd: std::env::current_dir()?,
            state_dir: state_dir.to_owned(),
        })
    }

    pub fn environment_id(&self) -> &str {
        self.descriptor["environmentId"]
            .as_str()
            .unwrap_or_default()
    }
}

/// Advertises no optional capability: each one promises a behavior clients then rely on.
pub fn descriptor(environment_id: &str, label: &str) -> Value {
    json!({
        "environmentId": environment_id,
        "label": label,
        "platform": { "os": os(), "arch": arch() },
        "serverVersion": CONTRACT_SERVER_VERSION,
        "orchestrationProtocolVersion": ORCHESTRATION_PROTOCOL_VERSION,
        "capabilities": { "repositoryIdentity": false },
    })
}

fn os() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "linux" => "linux",
        "windows" => "windows",
        _ => "unknown",
    }
}

fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        _ => "other",
    }
}
