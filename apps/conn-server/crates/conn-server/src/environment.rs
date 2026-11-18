//! The environment this server is: its stable id, its descriptor, where it keeps state, and
//! the stores clients configure it through (settings, keybindings, access).
//!
//! The state directory has the layout of the TypeScript server's (`<T3 home>/userdata`), so a
//! home moves between the two: `environment-id`, `settings.json` and `keybindings.json` are
//! shared files in the same format. See `DROP-IN.md` for the rest.

use std::{
    collections::HashMap,
    fs, io,
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
};

use conn_contract::{
    ExecutionEnvironmentCapabilities, ExecutionEnvironmentCapabilitiesFileAttachments,
    ExecutionEnvironmentDescriptor, ExecutionEnvironmentPlatform, ExecutionEnvironmentPlatformArch,
    ExecutionEnvironmentPlatformOs, OrbitInstanceDescriptor, ServerConfig,
};
use conn_support::text::js_trim;
use serde_json::{Value, json};

use crate::{
    auth::AuthStore, http::ORCHESTRATION_PROTOCOL_VERSION, keybindings::KeybindingsStore,
    settings::SettingsStore,
};

/// The `apps/server` version at the pinned Conn commit (generated into `conn-contract`).
/// Clients compare it with their own version; a lower one shows a "server is behind" hint. The
/// Codex provider sends the same value in `initialize`, as the T3 server does.
pub const CONTRACT_SERVER_VERSION: &str = conn_contract::T3_SERVER_VERSION;

/// Orbit writes this root-owned file before an Instance's first boot.
const ORBIT_INSTANCE_FILE: &str = "/etc/orbit/instance";
const ORBIT_INSTANCE_FILE_MAX_BYTES: u64 = 64 * 1024;
const MAX_SAFE_JS_INTEGER: i64 = 9_007_199_254_740_991;

pub struct Environment {
    pub restart: Arc<crate::restart::Restart>,
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

impl std::fmt::Debug for Environment {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Environment")
            .field("descriptor", &self.descriptor)
            .field("cwd", &self.cwd)
            .field("state_dir", &self.state_dir)
            .field("settings", &self.settings)
            .field("keybindings", &self.keybindings)
            .field("auth", &self.auth)
            .finish()
    }
}

impl Environment {
    /// Reads the environment id from `state_dir`, or creates one on first start, and opens
    /// the stores. `cwd` is the folder the server reports as its own.
    pub fn load(
        state_dir: &Path,
        label: Option<String>,
        cwd: PathBuf,
        restart: crate::restart::Restart,
    ) -> io::Result<Self> {
        fs::create_dir_all(state_dir)?;
        let environment_id = load_or_create_id(&state_dir.join("environment-id"))?;
        let label = label
            .or_else(|| std::env::var("HOSTNAME").ok())
            .or_else(hostname)
            .filter(|l| !l.trim().is_empty())
            .unwrap_or_else(|| "conn-server".into());
        Ok(Self {
            descriptor: descriptor(
                &environment_id,
                label.trim(),
                restart.available(),
                read_orbit_instance(Path::new(ORBIT_INSTANCE_FILE)),
            ),
            restart: Arc::new(restart),
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
            let id = conn_support::uuid_v4();
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

fn read_orbit_instance(path: &Path) -> Option<OrbitInstanceDescriptor> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return None,
        Err(error) => {
            eprintln!("conn-server: cannot open {}: {error}", path.display());
            return None;
        }
    };
    let mut text = String::new();
    match file
        .take(ORBIT_INSTANCE_FILE_MAX_BYTES + 1)
        .read_to_string(&mut text)
    {
        Ok(size) if (size as u64) <= ORBIT_INSTANCE_FILE_MAX_BYTES => parse_orbit_instance(&text),
        Ok(_) => {
            eprintln!(
                "conn-server: Orbit instance file is too large: {}",
                path.display()
            );
            None
        }
        Err(error) => {
            eprintln!("conn-server: cannot read {}: {error}", path.display());
            None
        }
    }
}

fn parse_orbit_instance(text: &str) -> Option<OrbitInstanceDescriptor> {
    let fields: HashMap<_, _> = text
        .lines()
        .map(js_trim)
        .filter(|line| !line.starts_with('#'))
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (js_trim(key), js_trim(value)))
        .collect();
    let field = |name| fields.get(name).copied().filter(|value| !value.is_empty());
    let id = |name| {
        let value = field(name)?;
        if value.starts_with('0') || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        let number = value.parse::<i64>().ok()?;
        (number <= MAX_SAFE_JS_INTEGER).then_some(number)
    };
    let project_id = id("ORBIT_PROJECT_ID")?;
    let instance_id = id("ORBIT_INSTANCE_ID")?;
    let url = field("ORBIT_URL").filter(|value| {
        url::Url::parse(value).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
    });

    Some(OrbitInstanceDescriptor {
        project_id,
        instance_id,
        project_slug: field("ORBIT_PROJECT").map(str::to_owned),
        project_name: field("ORBIT_PROJECT_NAME").and_then(orbit_project_name),
        instance_name: field("ORBIT_INSTANCE").map(str::to_owned),
        node_name: field("ORBIT_NODE").map(str::to_owned),
        url: url.map(str::to_owned),
    })
}

fn orbit_project_name(value: &str) -> Option<String> {
    let Some(quoted) = value.strip_prefix('"') else {
        return Some(value.to_owned());
    };
    let mut chars = quoted.strip_suffix('"')?.chars();
    let mut name = String::with_capacity(quoted.len());
    // Orbit's InstanceEnvironmentRenderer quotes the name without expanding shell syntax.
    while let Some(ch) = chars.next() {
        name.push(match ch {
            '\\' => match chars.next()? {
                ch @ ('\\' | '"' | '$') => ch,
                'n' => '\n',
                'r' => '\r',
                _ => return None,
            },
            '"' => return None,
            ch => ch,
        });
    }
    (!js_trim(&name).is_empty()).then_some(name)
}

/// `ExecutionEnvironmentDescriptor`, built from the contract type, so a new required field
/// upstream is a compile error here.
pub(crate) fn descriptor(
    environment_id: &str,
    label: &str,
    server_restart: bool,
    orbit_instance: Option<OrbitInstanceDescriptor>,
) -> Value {
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
        capabilities: capabilities(server_restart),
        orbit_instance,
    })
}

/// The one place for what this server advertises. A capability promises a behaviour that
/// clients then rely on, so each one here is served; every other one stays unset (off). This
/// covers the descriptor's `capabilities` and the flags `ServerConfig` carries
/// ([`config_flags`]).
pub fn capabilities(server_restart: bool) -> ExecutionEnvironmentCapabilities {
    // Every capability is optional; the test below proves this decode holds.
    let mut capabilities: ExecutionEnvironmentCapabilities =
        conn_contract::from_json(json!({})).expect("every capability is optional");
    capabilities.server_restart = server_restart.then_some(true);
    capabilities.repository_identity = Some(false);
    capabilities.server_browser = Some(true);
    // Uploads are claimed by the message that sends them (`host.rs`).
    capabilities.attachment_uploads = Some(true);
    capabilities.file_attachments = Some(ExecutionEnvironmentCapabilitiesFileAttachments {
        max_upload_bytes: i64::try_from(conn_files::attachments::MAX_FILE_BYTES)
            .unwrap_or(i64::MAX),
    });
    capabilities.pull_requests = Some(true);
    capabilities.pull_request_checks = Some(true);
    capabilities.linked_thread_refreshes = Some(true);
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
        let dir = std::env::temp_dir().join(format!("conn-env-{}", crate::auth::random_hex(6)));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("environment-id"),
            "0b6f1a52-3c1e-4d7a-9a55-2a1f8b0c9d10\n",
        )
        .unwrap();
        let env =
            Environment::load(&dir, Some("Box".into()), dir.clone(), Default::default()).unwrap();
        assert_eq!(env.environment_id(), "0b6f1a52-3c1e-4d7a-9a55-2a1f8b0c9d10");
        let fresh = dir.join("fresh");
        let made = Environment::load(&fresh, None, dir.clone(), Default::default()).unwrap();
        assert_eq!(made.environment_id().len(), 36);
        assert_eq!(
            fs::read_to_string(fresh.join("environment-id")).unwrap(),
            format!("{}\n", made.environment_id())
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_descriptor_decodes_and_advertises_only_what_is_served() {
        let descriptor = descriptor("0b6f1a52-3c1e-4d7a-9a55-2a1f8b0c9d10", "Box", false, None);
        assert!(descriptor["capabilities"].get("serverRestart").is_none());
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
                "linkedThreadRefreshes",
                "pullRequestChecks",
                "pullRequests",
                "serverBrowser",
                "shellOlderSettled",
                "shellThreadFamilies",
                "threadForceStop"
            ]
        );
    }
}

#[cfg(test)]
mod orbit_instance_tests {
    use super::*;

    #[test]
    fn reads_the_typescript_servers_orbit_instance_fixture() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../server/src/orbit/fixtures/orbit-instance");
        let facts = read_orbit_instance(&fixture);
        let descriptor = descriptor("existing-id", "Test server", false, facts);

        assert_eq!(descriptor["environmentId"], "existing-id");
        assert_eq!(
            descriptor["orbitInstance"],
            json!({
                "projectId": 7,
                "instanceId": 41,
                "projectSlug": "hauzer",
                "projectName": "Hauzer App",
                "instanceName": "t3-1a2b3c4d",
                "nodeName": "beast",
                "url": "https://t3-1a2b3c4d.hauzer.test",
            })
        );
    }

    #[test]
    fn a_host_without_the_instance_file_has_no_instance_facts() {
        let dir = std::env::temp_dir().join(conn_support::uuid_v4());
        let descriptor = descriptor(
            "existing-id",
            "Host",
            false,
            read_orbit_instance(&dir.join("instance")),
        );
        assert_eq!(descriptor["environmentId"], "existing-id");
        assert!(descriptor.get("orbitInstance").is_none());
    }

    #[test]
    fn an_old_incomplete_or_invalid_file_has_no_instance_facts() {
        for text in [
            "# Managed by Orbit.\nORBIT_INSTANCE_ID=41\nORBIT_INSTANCE=t3-1\nORBIT_PROJECT=hauzer\nORBIT_URL=\n",
            "ORBIT_PROJECT_ID=7\nORBIT_PROJECT=hauzer\n",
            "ORBIT_PROJECT_ID=7\nORBIT_INSTANCE_ID=0\n",
            "ORBIT_PROJECT_ID=7x\nORBIT_INSTANCE_ID=41\n",
            "ORBIT_PROJECT_ID=7\nORBIT_INSTANCE_ID=9007199254740992\n",
            "ORBIT_PROJECT_ID=+7\nORBIT_INSTANCE_ID=41\n",
            "ORBIT_PROJECT_ID=7\nORBIT_INSTANCE_ID=041\n",
        ] {
            assert_eq!(parse_orbit_instance(text), None, "{text}");
        }
    }

    #[test]
    fn skips_unknown_or_empty_facts_and_refuses_non_web_urls() {
        let facts = parse_orbit_instance(
            "# ORBIT_NODE=commented\n\nnot a pair\n=7\nORBIT_PROJECT_ID=7\r\nORBIT_INSTANCE_ID=41\nORBIT_PROJECT_NAME=\nORBIT_URL=javascript:alert(1)\nORBIT_FUTURE=1\n",
        ).unwrap();
        assert_eq!(
            conn_contract::to_json(&facts),
            json!({ "projectId": 7, "instanceId": 41 })
        );
    }

    #[test]
    fn trims_fields_but_keeps_spaces_and_embedded_equals() {
        let facts = parse_orbit_instance(
            "ORBIT_PROJECT_ID=7\nORBIT_INSTANCE_ID=41\nORBIT_PROJECT_NAME=old\nORBIT_PROJECT_NAME=  Hauzer = App  \n",
        ).unwrap();
        assert_eq!(
            conn_contract::to_json(&facts),
            json!({ "projectId": 7, "instanceId": 41, "projectName": "Hauzer = App" })
        );
    }

    #[test]
    fn reads_project_names_quoted_by_the_orbit_renderer() {
        for (value, expected) in [
            (
                r#""Studio \"North\" \$5 \\ = West""#,
                Some("Studio \"North\" $5 \\ = West"),
            ),
            (r#""  Studio  ""#, Some("  Studio  ")),
            (r#""""#, None),
            ("\" \u{feff} \"", None),
            ("\u{feff}", None),
            (r#""Bad \q""#, None),
            (r#""Missing end"#, None),
        ] {
            let file =
                format!("ORBIT_PROJECT_ID=7\nORBIT_INSTANCE_ID=41\nORBIT_PROJECT_NAME={value}\n");
            assert_eq!(
                parse_orbit_instance(&file).unwrap().project_name.as_deref(),
                expected,
                "{value}"
            );
        }
    }
}
