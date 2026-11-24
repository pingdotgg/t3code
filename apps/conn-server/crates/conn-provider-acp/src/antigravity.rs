//! Google Antigravity: the `agy` CLI serving ACP (`agy acp`), as T3's Antigravity driver runs
//! it (`apps/server/src/provider/Drivers/AntigravityDriver.ts`, `antigravityAuthSupport.ts`,
//! `acp/AntigravityAcpSupport.ts`, `orchestration-v2/Adapters/AntigravityAdapterV2.ts`).
//!
//! What differs from the shared runtime: a private profile folder (`GEMINI_HOME`) with the
//! sign-in method in its `settings.json`, the credential as `GEMINI_API_KEY` or
//! `GOOGLE_API_KEY`, `authenticate` before `session/new`, the pull request linking text as the
//! session's system prompt append, the model through the `model` config option, and file reads
//! the agent asks us for. The proof is `tools/antigravity-conformance.mjs`.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::flavor::{Completion, Flavor, Launch, ModelSwitch, SessionSetup, StopStyle};
use crate::ordered::{J, obj};
use conn_provider_support::instance::{InstanceEnv, InstanceEnvelope, trimmed};

pub(crate) const DRIVER: &str = "antigravity";
const DISPLAY_NAME: &str = "Antigravity";
/// `ANTIGRAVITY_DEFAULT_MODEL`: the selection that keeps the session's own model.
pub(crate) const DEFAULT_MODEL: &str = "antigravity-default";
/// `OPEN_MODEL_ACCESS_RELEASE`: from here on the agent offers every model to any client name.
const OPEN_MODEL_ACCESS_RELEASE: [u64; 3] = [1, 5, 1];
/// `ANTIGRAVITY_AUTH_STDOUT_PREFIX`: the line `agy` prints with a sign-in URL.
pub(crate) const AUTH_STDOUT_PREFIX: &str =
    "Open the following link to authenticate the ACP server: ";
/// `ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE`: a sign-in URL with no sign-in flow to take it.
pub(crate) const SIGN_IN_REQUIRED_MESSAGE: &str =
    "Sign in to Antigravity in Settings before you continue.";
/// `parseAntigravityAuthorizationUrl`'s failure text.
const INVALID_AUTH_URL: &str = "Antigravity returned an invalid Google sign-in URL.";
/// `maxAuthorizationUrlLength`.
const MAX_AUTH_URL: usize = 16_384;
/// `ANTIGRAVITY_AUTH_BROWSER_MARKER`: what our browser helper writes to stderr.
pub const AUTH_BROWSER_MARKER: &str = "__T3_ANTIGRAVITY_AUTH_URL__";
/// The subcommand of this server that stands in for a browser (`BROWSER`).
pub const BROWSER_SUBCOMMAND: &str = "antigravity-browser";

/// `removedEnvironmentKeys`: what the agent never inherits; the driver sets its own.
const REMOVED_ENV: &[&str] = &[
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_CLOUD_QUOTA_PROJECT",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GCLOUD_PROJECT",
    "CLOUDSDK_CORE_PROJECT",
    "AGY_ACP_CCPA_PROJECT",
    "AGY_ACP_ENABLE_OAUTH",
    "GEMINI_HOME",
    "AGY_ACP_FORCE_FILE_STORAGE",
    "ANTIGRAVITY_HARNESS_PATH",
    "BROWSER",
    "PYTHONUNBUFFERED",
    "ELECTRON_RUN_AS_NODE",
    "CHROME_CRASHPAD_PIPE_NAME",
];

// ---- settings -----------------------------------------------------------------------------

/// `AntigravitySettings` as the instance's `providerInstances` entry gives it. The API key is
/// the settings secret the server keeps (`apiKey`); `Debug` never prints it.
#[derive(Clone, PartialEq, Eq, Default)]
pub struct AntigravitySettings {
    pub enabled: bool,
    /// `authMethod`: `oauth-personal` (default), `oauth-business`, `gemini-api-key`,
    /// `agent-platform`.
    pub auth_method: String,
    pub api_key: String,
    pub gcp_project: String,
    pub gcp_location: String,
    /// `binaryPath`, trimmed; empty selects automatically.
    pub binary_path: String,
    pub display_name: Option<String>,
    pub accent_color: Option<String>,
    pub environment: InstanceEnv,
}

impl std::fmt::Debug for AntigravitySettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AntigravitySettings")
            .field("enabled", &self.enabled)
            .field("auth_method", &self.auth_method)
            .field("api_key_set", &!self.api_key.is_empty())
            .field("binary_path", &self.binary_path)
            .field("environment", &self.environment)
            .finish_non_exhaustive()
    }
}

const AUTH_METHODS: [&str; 4] = [
    "oauth-personal",
    "oauth-business",
    "gemini-api-key",
    "agent-platform",
];

impl AntigravitySettings {
    /// From the instance's entry (`AntigravitySettings` decode; `enabled` defaults to off).
    /// A key held by a secret provider (`{provider, reference}`) cannot be read here: no key.
    pub fn from_instance(entry: Option<&Value>) -> Self {
        let envelope = InstanceEnvelope::parse(entry, false);
        let config = &envelope.config;
        let text = |key: &str| config[key].as_str().map(str::trim).unwrap_or("").to_owned();
        let auth_method = config["authMethod"]
            .as_str()
            .filter(|m| AUTH_METHODS.contains(m))
            .unwrap_or("oauth-personal")
            .to_owned();
        Self {
            enabled: envelope.enabled,
            auth_method,
            api_key: config["apiKey"].as_str().unwrap_or("").to_owned(),
            gcp_project: text("gcpProject"),
            gcp_location: text("gcpLocation"),
            binary_path: config
                .get("binaryPath")
                .and_then(trimmed)
                .unwrap_or_default(),
            display_name: envelope.display_name,
            accent_color: envelope.accent_color,
            environment: envelope.environment,
        }
    }

    /// `antigravityAuthConfigIssue`.
    pub fn config_issue(&self) -> Option<&'static str> {
        match self.auth_method.as_str() {
            "oauth-business" if self.gcp_project.is_empty() || self.gcp_location.is_empty() => {
                Some(
                    "Gemini Enterprise needs a GCP project and location in the Antigravity provider settings.",
                )
            }
            "gemini-api-key" if self.api_key.is_empty() => {
                Some("Enter a Gemini API key in the Antigravity provider settings.")
            }
            "agent-platform"
                if self.api_key.is_empty()
                    && (self.gcp_project.is_empty() || self.gcp_location.is_empty()) =>
            {
                Some(
                    "Agent Platform needs an API key, or a GCP project and location, in the Antigravity provider settings.",
                )
            }
            _ => None,
        }
    }

    /// `antigravityAuthLabel`.
    fn auth_label(&self) -> &'static str {
        match self.auth_method.as_str() {
            "oauth-business" => "Gemini Enterprise",
            "gemini-api-key" => "Gemini API key",
            "agent-platform" => "Agent Platform",
            _ => "Google account",
        }
    }

    fn uses_credentials(&self) -> bool {
        matches!(
            self.auth_method.as_str(),
            "gemini-api-key" | "agent-platform"
        )
    }
}

// ---- the executable -----------------------------------------------------------------------

/// `AntigravityInstallation.resolve` for an agent this server did not install: the configured
/// path, or `agy` on `PATH`. Only the `agy` CLI (1.5.0+, `agy acp`) is supported; T3's managed
/// runtime with its `localharness_external` sibling is installed by T3 itself, and this
/// server installs nothing (Nick, 2026-11-14). Blocking: call it off the runtime thread.
pub(crate) fn resolve_executable(
    binary_path: &str,
    path_var: Option<&str>,
) -> Result<PathBuf, String> {
    let is_cli = |p: &Path| {
        p.file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| matches!(n.to_ascii_lowercase().as_str(), "agy" | "antigravity"))
    };
    if !binary_path.is_empty() {
        let candidate = expand_home(binary_path);
        let found = if candidate.components().count() > 1 {
            Some(absolute(&candidate)).filter(|p| is_executable(p))
        } else {
            search_path(&candidate, path_var)
        };
        return match found {
            Some(path) if is_cli(&path) || std::fs::canonicalize(&path).is_ok_and(|r| is_cli(&r)) => {
                Ok(path)
            }
            _ => Err("The custom Antigravity executable is missing or not executable, or it needs a localharness_external sibling. The agy CLI does not.".into()),
        };
    }
    search_path(Path::new("agy"), path_var).ok_or_else(|| {
        "Antigravity ACP runtime is not installed. Install it in this environment's provider settings or set a custom ACP executable path. The Antigravity app, IDE, and CLI are separate installations.".into()
    })
}

fn expand_home(path: &str) -> PathBuf {
    match (
        path.strip_prefix("~/"),
        conn_support::login_env::var_os("HOME"),
    ) {
        (Some(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ if path == "~" => conn_support::login_env::var_os("HOME")
            .map_or_else(|| PathBuf::from(path), PathBuf::from),
        _ => PathBuf::from(path),
    }
}

fn absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_path_buf();
    }
    std::env::current_dir().unwrap_or_default().join(path)
}

fn search_path(binary: &Path, path_var: Option<&str>) -> Option<PathBuf> {
    std::env::split_paths(path_var?)
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| absolute(&dir.join(binary)))
        .find(|candidate| is_executable(candidate))
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        metadata.is_file()
    }
}

// ---- profile and launch -------------------------------------------------------------------

/// `resolveAntigravityInstanceDirectories`: the profile and the runtime temp folder of one
/// instance, keyed by the SHA-256 of its id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Directories {
    pub profile: PathBuf,
    pub runtime_temp: PathBuf,
}

pub(crate) fn directories(state_dir: &Path, instance_id: &str) -> Directories {
    use sha2::Digest;
    let key = conn_support::hex::hex(&sha2::Sha256::digest(instance_id.as_bytes()));
    Directories {
        profile: state_dir.join("providers").join(DRIVER).join(&key),
        runtime_temp: state_dir
            .join("antigravity-tmp")
            .join(key.get(..12).unwrap_or(&key)),
    }
}

/// `prepareAntigravityProfile`: the profile folders (0700) and `antigravity-acp/settings.json`
/// with the sign-in method (never a credential). Blocking. The browser check T3 runs (its
/// Node helper) is not needed: our helper is this server's own executable.
/// Not ported: the links to the user's `~/.gemini` skills (`linkAntigravityUserSkills`).
pub(crate) fn prepare_profile(
    dirs: &Directories,
    settings: &AntigravitySettings,
) -> std::io::Result<()> {
    let acp = dirs.profile.join("antigravity-acp");
    for dir in [&dirs.profile, &acp, &dirs.runtime_temp] {
        std::fs::create_dir_all(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        }
    }
    std::fs::write(acp.join("settings.json"), profile_settings(settings))
}

/// `removeAntigravitySessionFiles`, after the agent closed: a native session's database,
/// metadata and brain folder go when its id is a v4 UUID and its metadata names `cwd`, the
/// unique scratch folder that proves the session is ours. Anything else leaves them.
pub(crate) fn remove_session_files(profile: &Path, session_id: &str, cwd: &str) {
    if !is_uuid_v4(session_id) {
        return;
    }
    let acp = profile.join("antigravity-acp");
    let conversations = acp.join("conversations");
    let Ok(text) = std::fs::read_to_string(conversations.join(format!("{session_id}.meta"))) else {
        return;
    };
    let named = serde_json::from_str::<Value>(&text).is_ok_and(|meta| meta["cwd"] == cwd);
    if !named {
        return;
    }
    for suffix in [".db", ".db-wal", ".db-shm", ".db-journal", ".meta"] {
        let _ = std::fs::remove_file(conversations.join(format!("{session_id}{suffix}")));
    }
    let _ = std::fs::remove_dir_all(acp.join("brain").join(session_id));
}

/// Effect's `isUUID(4)`: `xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx`, any case.
fn is_uuid_v4(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(at, byte)| match at {
            8 | 13 | 18 | 23 => *byte == b'-',
            14 => *byte == b'4',
            19 => matches!(byte.to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b'),
            _ => byte.is_ascii_hexdigit(),
        })
}

/// `antigravityProfileSettings`: `{"auth":{"type":…},"gcp":{…}}` and a newline.
fn profile_settings(settings: &AntigravitySettings) -> String {
    let mut gcp = serde_json::Map::new();
    if !settings.gcp_project.is_empty() {
        gcp.insert("project".into(), json!(settings.gcp_project));
    }
    if !settings.gcp_location.is_empty() {
        gcp.insert("location".into(), json!(settings.gcp_location));
    }
    let mut out = obj().with("auth", obj().with("type", settings.auth_method.clone()));
    if !gcp.is_empty() {
        out = out.with("gcp", Value::Object(gcp));
    }
    format!("{}\n", out.to_line())
}

/// `quoteBrowserArgument`.
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

/// `buildAntigravityAcpSpawnInput` for the `agy` CLI: `agy acp --gemini-dir <profile>
/// --app-data-dir antigravity-acp`, the inherited environment without the keys the driver owns
/// (`removedEnvironmentKeys`), then its own. `TMPDIR` is the process's own temp folder.
/// One accepted difference: `BROWSER` runs this server (`<self> antigravity-browser -- %s`),
/// where T3 runs its Node with an inline script; both only report the sign-in URL.
pub(crate) fn launch(
    executable: &Path,
    dirs: &Directories,
    settings: &AntigravitySettings,
    base_env: &[(String, String)],
    self_command: &str,
    run_temp: &Path,
) -> Launch {
    let mut env: Vec<(String, String)> = Vec::new();
    // The instance's own entries reach the agent, except the keys the driver owns.
    for (name, value) in base_env {
        if !REMOVED_ENV.contains(&name.to_ascii_uppercase().as_str()) {
            env.push((name.clone(), value.clone()));
        }
    }
    let credential = match settings.auth_method.as_str() {
        "gemini-api-key" if !settings.api_key.is_empty() => Some("GEMINI_API_KEY"),
        "agent-platform" if !settings.api_key.is_empty() => Some("GOOGLE_API_KEY"),
        _ => None,
    };
    if let Some(name) = credential {
        set(&mut env, name, &settings.api_key);
    }
    if cfg!(target_os = "linux")
        && !base_env
            .iter()
            .any(|(k, _)| k == "SSL_CERT_FILE" || k == "SSL_CERT_DIR")
        && let Some(bundle) = ca_bundle(base_env)
    {
        set(&mut env, "SSL_CERT_FILE", &bundle);
    }
    let gemini_home = dirs.profile.display().to_string();
    set(&mut env, "GEMINI_HOME", &gemini_home);
    set(&mut env, "AGY_ACP_FORCE_FILE_STORAGE", "1");
    let browser = [self_command, BROWSER_SUBCOMMAND, "--", "%s"]
        .iter()
        .map(|a| quote(a))
        .collect::<Vec<_>>()
        .join(" ");
    set(&mut env, "BROWSER", &browser);
    set(&mut env, "PYTHONUNBUFFERED", "1");
    set(&mut env, "ELECTRON_RUN_AS_NODE", "1");
    set(&mut env, "TMPDIR", &run_temp.display().to_string());
    Launch {
        program: executable.display().to_string(),
        args: vec![
            "acp".into(),
            "--gemini-dir".into(),
            gemini_home,
            "--app-data-dir".into(),
            // The CLI joins this beneath gemini-dir.
            "antigravity-acp".into(),
        ],
        env,
        env_remove: REMOVED_ENV.iter().map(|k| (*k).to_owned()).collect(),
    }
}

fn set(env: &mut Vec<(String, String)>, name: &str, value: &str) {
    env.retain(|(k, _)| k != name);
    env.push((name.to_owned(), value.to_owned()));
}

/// The bundled Python may look for certificates where this distribution has none.
fn ca_bundle(base_env: &[(String, String)]) -> Option<String> {
    let nix = base_env
        .iter()
        .find(|(k, _)| k == "NIX_SSL_CERT_FILE")
        .map(|(_, v)| v.clone());
    nix.into_iter()
        .chain(
            [
                "/etc/ssl/certs/ca-bundle.crt",
                "/etc/ssl/certs/ca-certificates.crt",
                "/etc/pki/tls/certs/ca-bundle.crt",
                "/etc/ssl/cert.pem",
            ]
            .map(str::to_owned),
        )
        .find(|c| Path::new(c).is_absolute() && Path::new(c).exists())
}

/// `conn-server antigravity-browser -- <url>`: the stand-in browser. It reports the URL on
/// stderr with T3's marker and exits 0, so the agent never opens a real browser.
pub fn browser_main(args: &[String]) -> i32 {
    use std::io::Write;
    let url = args
        .iter()
        .skip_while(|a| a.as_str() != "--")
        .nth(1)
        .cloned()
        .unwrap_or_default();
    let line = format!("{AUTH_BROWSER_MARKER}{}\n", json!(url));
    // A closed stderr means the client went away; T3's helper exits 0 then too.
    let _ = std::io::stderr().write_all(line.as_bytes());
    0
}

// ---- the flavor ---------------------------------------------------------------------------

fn version_triple(version: Option<&str>) -> Option<[u64; 3]> {
    let version = version?.trim();
    let mut parts = version.splitn(3, '.');
    let mut next = |last: bool| {
        let part = parts.next()?;
        let digits: String = if last {
            part.chars().take_while(char::is_ascii_digit).collect()
        } else {
            part.to_owned()
        };
        digits.parse::<u64>().ok()
    };
    Some([next(false)?, next(false)?, next(true)?])
}

/// The version in `agy --version` output (`1.5.13`): its first line, trimmed, when it starts
/// with a version triple.
pub(crate) fn cli_version(stdout: &str) -> Option<String> {
    let line = stdout.lines().next()?.trim();
    version_triple(Some(line)).map(|_| line.to_owned())
}

/// `antigravityClientInfo`: older releases offer non-Gemini models only to allowlisted
/// clients such as Zed. The `agy` CLI found on `PATH` has no known version, so it is Zed.
fn client_info(version: Option<&str>) -> (String, String) {
    match version_triple(version) {
        Some(v) if v >= OPEN_MODEL_ACCESS_RELEASE => {
            ("t3-code".into(), conn_contract::T3_SERVER_VERSION.into())
        }
        _ => ("zed".into(), "0.0.0".into()),
    }
}

/// `antigravityAppendsSystemPrompt`.
fn appends_system_prompt(initialize: &Value) -> bool {
    initialize["agentInfo"]["version"].as_str().map(str::trim) == Some("1.4.5")
        || initialize["agentCapabilities"]["_meta"]["antigravity"]["systemPrompt"]["append"] == true
}

/// `antigravitySessionMeta` with the conversational session's append (the pull request
/// linking text).
fn session_meta(initialize: &Value) -> Option<J> {
    let version = version_triple(initialize["agentInfo"]["version"].as_str());
    let writes_run_workflow = version.is_some_and(|v| ([1, 4, 2]..=[1, 4, 5]).contains(&v));
    let append = appends_system_prompt(initialize);
    if !writes_run_workflow && !append {
        return None;
    }
    let mut antigravity = obj();
    if writes_run_workflow {
        antigravity = antigravity.with("disabledTools", J::Arr(vec![J::from("run_workflow")]));
    }
    if append {
        antigravity = antigravity.with(
            "systemPrompt",
            obj().with("append", crate::instructions::PULL_REQUEST_LINKING),
        );
    }
    Some(obj().with("antigravity", antigravity))
}

/// `antigravityModelOptions`: the values of the `model` select option, groups flattened.
fn model_options(setup: &Value) -> (Option<String>, Option<String>, Vec<String>) {
    let options = setup["configOptions"].as_array();
    let model = options.and_then(|o| {
        o.iter()
            .find(|c| c["id"] == "model")
            .or_else(|| o.iter().find(|c| c["category"] == "model"))
    });
    let Some(model) = model.filter(|m| m["type"] == "select") else {
        return (None, None, Vec::new());
    };
    let values = model["options"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|entry| match entry.get("value") {
            Some(v) => vec![v.as_str().unwrap_or("").to_owned()],
            None => entry["options"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|o| o["value"].as_str().map(str::to_owned))
                .collect(),
        })
        .collect();
    (
        model["id"].as_str().map(str::to_owned),
        model["currentValue"].as_str().map(str::to_owned),
        values,
    )
}

/// `applyAntigravityAcpModelSelection`: the `model` config option and value to set, `None`
/// when the session keeps its model, or the refusal T3 gives. A selection that asks for the
/// default takes the catalog's `default_model` when the agent lists it (or its family), else
/// keeps the session's own model.
pub(crate) fn model_switch(
    setup: &Value,
    model: &str,
    default_model: Option<&str>,
) -> Result<Option<(String, String)>, String> {
    let (config_id, current, options) = model_options(setup);
    let explicit = !model.is_empty() && model != DEFAULT_MODEL;
    let legacy_family = |model: &str| {
        options
            .iter()
            .any(|family| model.starts_with(&format!("{family}-")))
    };
    let resolved = if explicit {
        Some(model.to_owned())
    } else {
        default_model
            .filter(|d| options.iter().any(|o| o == d) || legacy_family(d))
            .map(str::to_owned)
            .or_else(|| current.clone())
    };
    let Some(resolved) = resolved else {
        return Ok(None);
    };
    let Some(config_id) = config_id else {
        return Ok(None);
    };
    if current.as_deref() == Some(resolved.as_str()) {
        return Ok(None);
    }
    if options.contains(&resolved) {
        return Ok(Some((config_id, resolved)));
    }
    // `legacyAntigravityFamily`: 1.3 ids such as `gemini-3.8-flash-high` still work.
    if legacy_family(&resolved) {
        return Ok(Some((config_id, resolved)));
    }
    Err(format!(
        "Antigravity model '{resolved}' is unavailable for this Google account. Select an available model."
    ))
}

/// Records a config option's new value in the setup result.
pub(crate) fn set_current(setup: &mut Value, config_id: &str, value: &str) {
    if let Some(options) = setup["configOptions"].as_array_mut()
        && let Some(option) = options.iter_mut().find(|o| o["id"] == config_id)
    {
        option["currentValue"] = json!(value);
    }
}

/// `antigravityApprovalOptions` (the security warning of `allow_always` is not carried).
fn approval_options(options: &[(String, String)]) -> Value {
    let has = |kind: &str| {
        options
            .iter()
            .any(|(id, k)| k == kind && !id.trim().is_empty())
    };
    let mut decisions = Vec::new();
    if has("allow_once") {
        decisions.push(json!({"decision": "accept", "label": "Allow once"}));
    }
    if has("allow_always") {
        decisions.push(json!({"decision": "acceptForSession", "label": "Allow for this thread"}));
    }
    if has("reject_once") {
        decisions.push(json!({"decision": "decline", "label": "Deny"}));
    }
    decisions.push(json!({"decision": "cancel", "label": "Cancel"}));
    Value::Array(decisions)
}

/// `AntigravityProviderCapabilitiesV2`.
fn capabilities() -> Value {
    let mut caps = crate::flavor::acp_capabilities();
    caps["sessions"]["supportsModelSwitchInSession"] = json!(true);
    caps["sessions"]["supportsRuntimeModeSwitchInSession"] = json!(true);
    caps["tools"]["supportsMcpTools"] = json!(true);
    caps["subagents"]["supportsSubagents"] = json!(true);
    caps
}

pub static ANTIGRAVITY: Flavor = Flavor {
    driver: DRIVER,
    harness: "Antigravity",
    // The provider builds the launch itself (`launch`): it needs the profile and temp folder.
    launch: |binary, _, environment| Launch {
        program: binary.to_owned(),
        args: vec!["acp".into()],
        env: environment.to_vec(),
        env_remove: Vec::new(),
    },
    initialize_meta: None,
    client_info: Some(client_info),
    client_file_reads: true,
    authenticate_eagerly: true,
    session_setup: Some(SessionSetup {
        meta: session_meta,
        attachments_directory: true,
        carries_linking: appends_system_prompt,
    }),
    model_switch: ModelSwitch::ConfigOption,
    resume: true,
    cancel_meta: None,
    // `cancelBehavior: "wait-for-prompt"`: the agent stays and ends its own prompt.
    stop: StopStyle::Cancel,
    completion: Completion::Reply,
    approval_options,
    prompt_failure: |message, code| {
        crate::flavor::provider_failure(message, "provider_error", code)
    },
    permission_override: |_| None,
    select_model: |_, _, _, _| None,
    normalize_tool: None,
    capabilities,
    // ACP 1.3.0 treats /compact as ordinary model input.
    supports_compaction: false,
    background: None,
    mcp_over_http: true,
    supports_image_prompts: true,
    rpc_failure,
    stdout_signal: Some(stdout_signal),
};

/// `ProviderError::Failed` operation of an error reply that asks for a Google sign-in.
pub(crate) const SIGN_IN_REQUIRED: &str = "sign-in-required";
/// `ProviderError::Failed` operation of an error reply whose details T3 shows.
pub(crate) const RECEIVE_RESPONSE: &str = "receive-response";
/// `AntigravityDriver.ts`'s `PYTHON_SOCKS_REQUIRED` (`tools/check-copies.mjs`).
pub(crate) const PYTHON_SOCKS_REQUIRED: &str = "python-socks is required to use a SOCKS proxy";
/// `NATIVE_CLI_NO_BROWSER_PREFIX` (`antigravityAuthSupport.ts`).
const NO_BROWSER_PREFIX: &str = "No browser is available here";

/// `isAntigravitySignInRequiredError` for an error reply (auth required, or the native CLI's
/// browser sign-in that cannot open), and the `python-socks` details T3 passes on. The other
/// replies keep the generic failure.
fn rpc_failure(error: &crate::protocol::RpcError) -> Option<conn_provider::ProviderError> {
    let detail = conn_provider_support::redact::redact(&error.message);
    if error.code == -32000
        || (error.code == -32603 && error.message.starts_with(NO_BROWSER_PREFIX))
    {
        return Some(conn_provider::ProviderError::Failed {
            operation: SIGN_IN_REQUIRED,
            detail,
        });
    }
    let details = error
        .data
        .as_ref()
        .and_then(|data| data.get("details"))
        .and_then(Value::as_str);
    details
        .filter(|details| details.contains(PYTHON_SOCKS_REQUIRED))
        .map(|_| conn_provider::ProviderError::Failed {
            operation: RECEIVE_RESPONSE,
            detail: PYTHON_SOCKS_REQUIRED.to_owned(),
        })
}

// ---- the `ServerProvider` entry -----------------------------------------------------------

/// What the entry shows beyond the settings (`makeAntigravityProvider`'s draft).
#[derive(Clone, Debug, Default)]
pub(crate) struct Observed {
    pub installed: bool,
    pub version: Option<String>,
    /// `null` until checked; then T3's status of the last check or session.
    pub status: Option<&'static str>,
    pub authenticated: bool,
    /// The agent asked for a sign-in (`onAuthRequired`): the entry says so, and health checks
    /// open no session until one proves the sign-in again.
    pub signed_out: bool,
    pub message: Option<String>,
    pub models: Vec<Value>,
    /// The thinking option each model reported while selected (T3's `thinkingLevels`);
    /// `None`: it has none. One entry per listed model at most; cleared on sign-out.
    pub thinking_levels: std::collections::BTreeMap<String, Option<Value>>,
    /// The agent's commands (`onAvailableCommands`), machine-wide.
    pub slash_commands: Vec<Value>,
    /// What sessions in each workspace reported, at most [`MAX_WORKSPACE_SNAPSHOTS`].
    pub workspaces: Vec<Value>,
}

/// `MAX_WORKSPACE_SNAPSHOTS` (`AntigravityProvider.ts`).
const MAX_WORKSPACE_SNAPSHOTS: usize = 32;

/// The bundled Antigravity catalog (`tools/gen-model-catalog.mjs`).
const BUNDLED_CATALOG: &str = include_str!("antigravity_catalog.json");

/// The parts of `ModelCatalog.current("antigravity")` this driver reads.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Catalog {
    pub default_model: Option<String>,
    /// Slugs with their status (`current` or `legacy`).
    pub models: Vec<(String, String)>,
}

/// `ModelCatalog.current`: the manifest the server accepted last, else the bundled one. `None`
/// when the accepted manifest has no valid Antigravity catalog (`resolveProviderCatalog`).
pub(crate) fn catalog(manifest: &conn_provider::LiveManifest) -> Option<Catalog> {
    let section = match manifest.provider_catalog(DRIVER) {
        None => return bundled_catalog().clone(),
        Some(section) => section?,
    };
    catalog_from(&section)
}

/// The bundled catalog, parsed once.
fn bundled_catalog() -> &'static Option<Catalog> {
    static BUNDLED: std::sync::OnceLock<Option<Catalog>> = std::sync::OnceLock::new();
    BUNDLED.get_or_init(|| {
        serde_json::from_str::<Value>(BUNDLED_CATALOG)
            .ok()
            .and_then(|section| catalog_from(&section))
    })
}

/// `resolveProviderCatalog`'s checks on one catalog: unique slugs, known profiles, a listed
/// default.
fn catalog_from(section: &Value) -> Option<Catalog> {
    let default_model = section
        .get("defaultChatModel")
        .or_else(|| section.pointer("/defaults/chat"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mut models: Vec<(String, String)> = Vec::new();
    for entry in section.get("models")?.as_array()? {
        let slug = entry.get("slug")?.as_str()?.to_owned();
        if models.iter().any(|(s, _)| *s == slug) {
            return None;
        }
        if let Some(profile) = entry.get("profile").and_then(Value::as_str)
            && section.pointer(&format!("/profiles/{profile}")).is_none()
            && section.get("defaultChatModel").is_none()
        {
            return None;
        }
        models.push((
            slug,
            entry["status"].as_str().unwrap_or("current").to_owned(),
        ));
    }
    if default_model
        .as_ref()
        .is_some_and(|d| !models.iter().any(|(s, _)| s == d))
    {
        return None;
    }
    Some(Catalog {
        default_model,
        models,
    })
}

/// `applyModelCatalog` without family matching: the catalog's legacy marks, and its default
/// takes the default mark and aliases when the agent lists it.
pub(crate) fn apply_catalog(models: &mut [Value], catalog: Option<&Catalog>) {
    for model in models.iter_mut() {
        if model["isCustom"] == true {
            continue;
        }
        let legacy = catalog.is_some_and(|c| {
            c.models
                .iter()
                .any(|(slug, status)| model["slug"] == slug.as_str() && status == "legacy")
        });
        if let Some(fields) = model.as_object_mut() {
            if legacy {
                fields.insert("isLegacy".into(), json!(true));
            } else {
                fields.remove("isLegacy");
            }
        }
    }
    let Some(requested) = catalog.and_then(|c| c.default_model.as_deref()) else {
        return;
    };
    if !models.iter().any(|m| m["slug"] == requested) {
        return;
    }
    let Some(previous) = models
        .iter()
        .find(|m| m["isDefault"] == true && m["slug"] != requested)
        .cloned()
    else {
        return;
    };
    let moved = previous["aliases"].as_array().cloned().unwrap_or_default();
    for model in models.iter_mut() {
        let Some(fields) = model.as_object_mut() else {
            continue;
        };
        if fields.get("slug") == previous.get("slug") {
            fields.remove("isDefault");
            fields.remove("aliases");
        } else if fields.get("slug").and_then(Value::as_str) == Some(requested) {
            let mut aliases = fields
                .get("aliases")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for alias in &moved {
                if !aliases.contains(alias) {
                    aliases.push(alias.clone());
                }
            }
            fields.insert("isDefault".into(), json!(true));
            if !aliases.is_empty() {
                fields.insert("aliases".into(), Value::Array(aliases));
            }
        }
    }
}

/// `nativeCommands`: named commands once each, with a trimmed description and input hint.
fn native_commands(commands: &Value) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for command in commands.as_array().into_iter().flatten() {
        let Some(name) = command["name"].as_str() else {
            continue;
        };
        if name.trim().is_empty() || !seen.insert(name.to_owned()) {
            continue;
        }
        let mut entry = serde_json::Map::new();
        entry.insert("name".into(), json!(name));
        let description = command["description"].as_str().unwrap_or("").trim();
        if !description.is_empty() {
            entry.insert("description".into(), json!(description));
        }
        let hint = command["input"]["hint"].as_str().unwrap_or("").trim();
        if !hint.is_empty() {
            entry.insert("input".into(), json!({"hint": hint}));
        }
        out.push(Value::Object(entry));
    }
    out
}

/// Puts `snapshot` (for its `cwd`) last, dropping the oldest past the limit.
fn upsert_workspace(workspaces: &mut Vec<Value>, snapshot: Value) {
    workspaces.retain(|w| w["cwd"] != snapshot["cwd"]);
    workspaces.push(snapshot);
    if workspaces.len() > MAX_WORKSPACE_SNAPSHOTS {
        let extra = workspaces.len() - MAX_WORKSPACE_SNAPSHOTS;
        workspaces.drain(..extra);
    }
}

/// `onAvailableCommands`: the agent's commands, machine-wide and, for a session's `cwd`, in
/// that workspace's snapshot. Ignored while signed out.
pub(crate) fn available_commands(
    previous: &Observed,
    commands: &Value,
    cwd: Option<&str>,
    now: &str,
) -> Observed {
    let mut next = previous.clone();
    if next.signed_out {
        return next;
    }
    next.slash_commands = native_commands(commands);
    if let Some(cwd) = cwd {
        let skills = previous
            .workspaces
            .iter()
            .find(|w| w["cwd"] == cwd)
            .map_or_else(|| json!([]), |w| w["skills"].clone());
        upsert_workspace(
            &mut next.workspaces,
            json!({"cwd": cwd, "checkedAt": now, "slashCommands": next.slash_commands, "skills": skills}),
        );
    }
    next
}

/// `buildServerProvider` + `withInstanceIdentity` for Antigravity.
pub(crate) fn entry(
    instance_id: &str,
    settings: &AntigravitySettings,
    observed: &Observed,
    checked_at: &str,
    catalog: Option<&Catalog>,
) -> Value {
    let auth = if observed.authenticated {
        json!({"status": "authenticated", "type": settings.auth_method, "label": settings.auth_label()})
    } else if observed.signed_out {
        if settings.uses_credentials() {
            json!({"status": "unauthenticated", "type": settings.auth_method, "label": settings.auth_label()})
        } else {
            json!({"status": "unauthenticated"})
        }
    } else {
        json!({"status": "unknown", "type": settings.auth_method})
    };
    let status = if !settings.enabled {
        "disabled"
    } else {
        observed.status.unwrap_or("warning")
    };
    let message = if settings.enabled {
        observed
            .message
            .clone()
            .unwrap_or_else(|| "Checking Antigravity availability.".into())
    } else {
        "Antigravity is disabled in Conn settings.".into()
    };
    let mut entry = serde_json::Map::new();
    entry.insert("displayName".into(), json!(DISPLAY_NAME));
    entry.insert("showInteractionModeToggle".into(), json!(false));
    entry.insert(
        "supportedRuntimeModes".into(),
        json!(["approval-required", "auto-accept-edits", "full-access"]),
    );
    entry.insert("enabled".into(), json!(settings.enabled));
    entry.insert("installed".into(), json!(observed.installed));
    entry.insert("version".into(), json!(observed.version));
    entry.insert("status".into(), json!(status));
    entry.insert("auth".into(), auth);
    entry.insert("checkedAt".into(), json!(checked_at));
    if !(observed.authenticated && settings.enabled && observed.status == Some("ready")) {
        entry.insert("message".into(), json!(message));
    }
    let mut models = observed.models.clone();
    apply_catalog(&mut models, catalog);
    entry.insert("models".into(), Value::Array(models));
    entry.insert(
        "slashCommands".into(),
        Value::Array(observed.slash_commands.clone()),
    );
    entry.insert("skills".into(), json!([]));
    // Orbit installs and updates every provider CLI and owns `PATH`; this server installs
    // nothing (Nick, 2026-11-20). T3 says `canInstall: true` for its managed runtime.
    entry.insert(
        "setup".into(),
        json!({"canAuthenticate": true, "canInstall": false}),
    );
    entry.insert("supportsConversationRollback".into(), json!(true));
    entry.insert("supportsTextGeneration".into(), json!(false));
    entry.insert(
        "workspaceSnapshots".into(),
        Value::Array(observed.workspaces.clone()),
    );
    entry.insert("instanceId".into(), json!(instance_id));
    entry.insert("driver".into(), json!(DRIVER));
    if let Some(name) = &settings.display_name {
        entry.insert("displayName".into(), json!(name));
    }
    if let Some(color) = &settings.accent_color {
        entry.insert("accentColor".into(), json!(color));
    }
    entry.insert(
        "continuation".into(),
        json!({"groupKey": format!("{DRIVER}:instance:{instance_id}")}),
    );
    Value::Object(entry)
}

/// `checkAntigravityProvider`'s probe: the executable resolves and the sign-in is configured.
/// The agent starts only when [`needs_session`] says so.
/// `version` is what `<agy> --version` printed in this check ([`cli_version`]); it replaces
/// the last one, so the version follows the binary on `PATH` when Orbit updates it. A missing
/// executable or a failed `--version` leaves no version.
pub(crate) fn check(
    settings: &AntigravitySettings,
    previous: &Observed,
    executable: Result<PathBuf, String>,
    version: Option<String>,
) -> Observed {
    let mut next = previous.clone();
    next.version = version.filter(|_| executable.is_ok());
    let error = match (&executable, settings.config_issue()) {
        (_, Some(issue)) => Some(issue.to_owned()),
        (Err(detail), None) => Some(detail.clone()),
        (Ok(_), None) => None,
    };
    let missing = executable.is_err() && settings.config_issue().is_none();
    next.installed = !missing;
    if missing {
        next.models.clear();
        next.slash_commands.clear();
        next.workspaces.clear();
    }
    next.status = Some(match (&error, next.authenticated) {
        (Some(_), _) => "error",
        (None, true) => "ready",
        (None, false) => "warning",
    });
    next.message = error.or_else(|| {
        (!next.authenticated).then(|| {
            if next.signed_out {
                sign_in_message(settings)
            } else if settings.uses_credentials() {
                format!(
                    "Antigravity is installed. Connect with {} to load models.",
                    settings.auth_label()
                )
            } else {
                "Antigravity is installed. Google account access is not checked yet.".into()
            }
        })
    });
    next
}

/// Whether a health check should open a throwaway session (`loadModels`): only a session
/// proves the sign-in and lists the models, so the check opens one while neither is known.
pub(crate) fn needs_session(observed: &Observed) -> bool {
    observed.installed
        && observed.status == Some("warning")
        && !observed.authenticated
        && !observed.signed_out
}

/// `AntigravityProvider.ts`'s `SIGN_IN_MESSAGE` (`tools/check-copies.mjs`).
const SIGN_IN_MESSAGE: &str = "Sign in with Google to use Antigravity.";

/// `signInMessage`.
fn sign_in_message(settings: &AntigravitySettings) -> String {
    if settings.uses_credentials() {
        format!(
            "Connect with {} to use Antigravity and load models.",
            settings.auth_label()
        )
    } else {
        SIGN_IN_MESSAGE.to_owned()
    }
}

/// `onAuthRequired` (`clearAccountMetadata`): the agent asked for a sign-in, so the entry
/// shows it and drops the account's models. A disabled instance keeps its entry.
pub(crate) fn auth_required(settings: &AntigravitySettings, previous: &Observed) -> Observed {
    if !settings.enabled {
        return previous.clone();
    }
    Observed {
        installed: previous.installed,
        version: previous.version.clone(),
        status: Some("warning"),
        authenticated: false,
        signed_out: true,
        message: Some(sign_in_message(settings)),
        models: Vec::new(),
        thinking_levels: Default::default(),
        slash_commands: Vec::new(),
        workspaces: Vec::new(),
    }
}

/// `observeThinkingLevels`: the thinking option the selected model reports. Levels stay until
/// sign-out, also for a model the agent no longer lists, as T3 keeps them.
fn observe_thinking_levels(
    levels: &mut std::collections::BTreeMap<String, Option<Value>>,
    options: &Value,
) {
    let model = options.as_array().and_then(|options| {
        options
            .iter()
            .find(|o| o["id"] == "model" || o["category"] == "model")
    });
    if let Some(model) = model
        && model["type"] == "select"
        && let Some(current) = model["currentValue"].as_str().filter(|c| !c.is_empty())
    {
        levels.insert(current.to_owned(), thinking_config(options).cloned());
    }
}

/// `onConfigOptionsUpdated`: the selected model's thinking levels are recorded, and the
/// models are listed again while the account is signed in.
pub(crate) fn config_options_updated(previous: &Observed, options: &Value) -> Observed {
    let mut next = previous.clone();
    observe_thinking_levels(&mut next.thinking_levels, options);
    if next.authenticated {
        next.models =
            models_from_session(&json!({"configOptions": options}), &next.thinking_levels);
    }
    next
}

/// `antigravityThinkingConfig`: the `thought_level` select option.
pub(crate) fn thinking_config(options: &Value) -> Option<&Value> {
    options
        .as_array()?
        .iter()
        .find(|o| o["category"] == "thought_level")
        .filter(|o| o["type"] == "select")
}

/// The thinking level a selection chose, when the session offers it and has another one
/// (T3's selection loop over the live config options): `(config id, value)` to write.
pub(crate) fn thinking_write(options: &Value, selections: &[Value]) -> Option<(String, String)> {
    let config = thinking_config(options)?;
    let id = config["id"].as_str()?;
    let chosen = selections.iter().find(|s| s["id"] == id)?["value"].as_str()?;
    let value = if chosen == "_t3/empty" { "" } else { chosen };
    let offered = flatten_choices(&config["options"])
        .iter()
        .any(|choice| choice["value"] == value);
    (offered && config["currentValue"] != value).then(|| (id.to_owned(), value.to_owned()))
}

/// `antigravityModelOptions`: the values of the `model` option.
pub(crate) fn model_option_values(options: &Value) -> Vec<String> {
    let model = options
        .as_array()
        .and_then(|options| options.iter().find(|o| o["id"] == "model"));
    let Some(model) = model.filter(|m| m["type"] == "select") else {
        return Vec::new();
    };
    flatten_choices(&model["options"])
        .into_iter()
        .filter_map(|entry| entry["value"].as_str().map(str::to_owned))
        .collect()
}

/// `flattenSelectChoices`: grouped choices in order.
fn flatten_choices(options: &Value) -> Vec<&Value> {
    options
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|entry| {
            if entry.get("value").is_some() {
                vec![entry]
            } else {
                entry["options"].as_array().into_iter().flatten().collect()
            }
        })
        .collect()
}

/// `boundedText`.
fn bounded_text(value: &Value, max: usize) -> String {
    value
        .as_str()
        .unwrap_or("")
        .trim()
        .chars()
        .take(max)
        .collect()
}

/// `choiceId`: the empty value as T3's placeholder, else a value without outer spaces.
fn choice_id(value: &str) -> Option<String> {
    if value.is_empty() {
        return Some("_t3/empty".to_owned());
    }
    (value == value.trim() && value.chars().count() <= 256).then(|| value.to_owned())
}

/// `thinkingCapabilities`: the thinking option as a reasoning descriptor
/// (`acpProviderOptionDescriptors`). A level another model selected is not this model's
/// default, so an unobserved model gets the levels without the current one.
fn thinking_capabilities(config: Option<&Value>, observed: bool) -> Value {
    let empty = json!({"optionDescriptors": []});
    let Some(config) = config else {
        return empty;
    };
    let Some(id) = config["id"]
        .as_str()
        .and_then(choice_id)
        .filter(|id| id != "_t3/empty")
    else {
        return empty;
    };
    let mut seen = std::collections::HashSet::new();
    let mut choices = Vec::new();
    for candidate in flatten_choices(&config["options"]) {
        let Some(choice) = candidate["value"].as_str().and_then(choice_id) else {
            continue;
        };
        if !seen.insert(choice.clone()) {
            continue;
        }
        let label = bounded_text(&candidate["name"], 256);
        let mut entry = serde_json::Map::new();
        entry.insert("id".into(), json!(choice));
        entry.insert(
            "label".into(),
            json!(if label.is_empty() {
                choice.clone()
            } else {
                label
            }),
        );
        let description = bounded_text(&candidate["description"], 1024);
        if !description.is_empty() {
            entry.insert("description".into(), json!(description));
        }
        choices.push(Value::Object(entry));
        if choices.len() == 64 {
            break;
        }
    }
    if choices.is_empty() {
        return empty;
    }
    let label = bounded_text(&config["name"], 256);
    let mut descriptor = serde_json::Map::new();
    let label = if label.is_empty() { id.clone() } else { label };
    descriptor.insert("id".into(), json!(id));
    descriptor.insert("label".into(), json!(label));
    let description = bounded_text(&config["description"], 1024);
    if !description.is_empty() {
        descriptor.insert("description".into(), json!(description));
    }
    descriptor.insert("type".into(), json!("select"));
    let current = config["currentValue"].as_str().and_then(choice_id);
    if observed
        && let Some(current) = current
        && choices.iter().any(|c| c["id"] == current.as_str())
    {
        descriptor.insert("currentValue".into(), json!(current));
    }
    descriptor.insert("options".into(), Value::Array(choices));
    descriptor.insert("role".into(), json!("reasoning"));
    json!({"optionDescriptors": [Value::Object(descriptor)]})
}

/// `onSessionStarted`: the session proves the sign-in; its models are listed. A version from
/// a health check's `--version` stays; the session's own counts only before one.
pub(crate) fn session_started(
    previous: &Observed,
    initialize: &Value,
    setup: &Value,
    cwd: Option<(&str, &str)>,
) -> Observed {
    let session_version = initialize["agentInfo"]["version"]
        .as_str()
        .filter(|v| !v.is_empty())
        .map(str::to_owned);
    let mut thinking_levels = previous.thinking_levels.clone();
    observe_thinking_levels(&mut thinking_levels, &setup["configOptions"]);
    Observed {
        installed: true,
        version: previous.version.clone().or(session_version),
        status: Some("ready"),
        authenticated: true,
        signed_out: false,
        message: None,
        models: models_from_session(setup, &thinking_levels),
        thinking_levels,
        slash_commands: previous.slash_commands.clone(),
        workspaces: {
            // A session's workspace gets a snapshot: its commands so far, else the machine's.
            let mut workspaces = previous.workspaces.clone();
            if let Some((cwd, now)) = cwd {
                let kept = previous.workspaces.iter().find(|w| w["cwd"] == cwd);
                let commands = kept.map_or_else(
                    || Value::Array(previous.slash_commands.clone()),
                    |w| w["slashCommands"].clone(),
                );
                let skills = kept.map_or_else(|| json!([]), |w| w["skills"].clone());
                upsert_workspace(
                    &mut workspaces,
                    json!({"cwd": cwd, "checkedAt": now, "slashCommands": commands, "skills": skills}),
                );
            }
            workspaces
        },
    }
}

/// `buildAntigravityModelsFromSession`: the `model` option's values (or the session's
/// `models`), the current one the default with the `antigravity-default` alias, each with
/// the thinking levels it reported while selected.
pub(crate) fn models_from_session(
    setup: &Value,
    thinking_levels: &std::collections::BTreeMap<String, Option<Value>>,
) -> Vec<Value> {
    let current_thinking = thinking_config(&setup["configOptions"]);
    let (_, current, _) = model_options(setup);
    let options = setup["configOptions"].as_array();
    let model = options.and_then(|o| {
        o.iter()
            .find(|c| c["id"] == "model" || c["category"] == "model")
    });
    let entries: Vec<(String, String)> = match model {
        Some(m) if m["type"] == "select" => m["options"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|entry| {
                if entry.get("value").is_some() {
                    vec![entry.clone()]
                } else {
                    entry["options"].as_array().cloned().unwrap_or_default()
                }
            })
            .map(|e| {
                (
                    e["value"].as_str().unwrap_or("").to_owned(),
                    e["name"].as_str().unwrap_or("").to_owned(),
                )
            })
            .collect(),
        Some(_) => Vec::new(),
        None => setup["models"]["availableModels"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|m| {
                (
                    m["modelId"].as_str().unwrap_or("").to_owned(),
                    m["name"].as_str().unwrap_or("").to_owned(),
                )
            })
            .collect(),
    };
    let current = current.or_else(|| {
        setup["models"]["currentModelId"]
            .as_str()
            .map(str::to_owned)
    });
    let mut seen = std::collections::HashSet::new();
    let mut names = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (value, name) in entries {
        if value.trim().is_empty() || !seen.insert(value.clone()) {
            continue;
        }
        let base = if name.trim().is_empty() {
            value.clone()
        } else {
            name
        };
        let label = if names.contains(&base) {
            format!("{base} ({value})")
        } else {
            base.clone()
        };
        names.insert(base);
        let capabilities = if current.as_deref() == Some(value.as_str()) {
            thinking_capabilities(current_thinking, true)
        } else {
            match thinking_levels.get(&value) {
                Some(observed) => thinking_capabilities(observed.as_ref(), true),
                None => thinking_capabilities(current_thinking, false),
            }
        };
        let mut model = json!({
            "slug": value,
            "name": label,
            "isCustom": false,
            "capabilities": capabilities,
        });
        if current.as_deref() == Some(value.as_str()) {
            model["isDefault"] = json!(true);
            model["aliases"] = json!([DEFAULT_MODEL]);
        }
        out.push(model);
    }
    out
}

// ---- sign-in URLs ---------------------------------------------------------------------------

/// `parseAntigravityAuthorizationUrl`: Google's OAuth URL with one `state` (1 to 512
/// characters, no spaces), one `response_type=code` and one loopback `redirect_uri` on a port
/// from 1024.
pub(crate) fn is_authorization_url(url: &str) -> bool {
    if url.len() > MAX_AUTH_URL || url.chars().any(char::is_whitespace) || url.contains('#') {
        return false;
    }
    let Some(query) = url.strip_prefix("https://accounts.google.com/o/oauth2/v2/auth?") else {
        return false;
    };
    let pairs: Vec<(String, String)> = query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (percent_decode(key), percent_decode(value))
        })
        .collect();
    let one = |key: &str| {
        let mut found = pairs.iter().filter(|(k, _)| k == key);
        match (found.next(), found.next()) {
            (Some((_, value)), None) => Some(value.as_str()),
            _ => None,
        }
    };
    let state_ok = one("state").is_some_and(|state| {
        !state.is_empty() && state.chars().count() <= 512 && !state.chars().any(char::is_whitespace)
    });
    let redirect_ok = one("redirect_uri").is_some_and(|uri| {
        uri.strip_prefix("http://127.0.0.1:")
            .and_then(|rest| rest.strip_suffix('/'))
            .filter(|port| {
                !port.is_empty()
                    && port.len() <= 5
                    && !port.starts_with('0')
                    && port.bytes().all(|b| b.is_ascii_digit())
            })
            .and_then(|port| port.parse::<u32>().ok())
            .is_some_and(|port| (1024..=65535).contains(&port))
    });
    state_ok && redirect_ok && one("response_type") == Some("code")
}

/// `application/x-www-form-urlencoded` decoding, as `URLSearchParams` reads a query.
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while let Some(&byte) = bytes.get(i) {
        let hex = |at: usize| bytes.get(at).and_then(|b| (*b as char).to_digit(16));
        match byte {
            b'+' => out.push(b' '),
            b'%' => match (hex(i + 1), hex(i + 2)) {
                (Some(high), Some(low)) => {
                    out.push(u8::try_from(high * 16 + low).unwrap_or(b'?'));
                    i += 2;
                }
                _ => out.push(b'%'),
            },
            other => out.push(other),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `makeAntigravityStdoutTransform` with no sign-in flow (this server has none): a sign-in URL
/// ends the session with the sign-in instruction; a malformed one fails it.
pub(crate) fn stdout_signal(line: &str) -> Option<conn_provider::ProviderError> {
    let url = line
        .strip_prefix(AUTH_STDOUT_PREFIX)?
        .trim_end_matches(['\r', '\n']);
    Some(if is_authorization_url(url) {
        conn_provider::ProviderError::Failed {
            operation: SIGN_IN_REQUIRED,
            detail: SIGN_IN_REQUIRED_MESSAGE.to_owned(),
        }
    } else {
        conn_provider::ProviderError::Failed {
            operation: "authorization-url",
            detail: INVALID_AUTH_URL.to_owned(),
        }
    })
}

/// `makeAntigravityStderrHandler`'s sign-in signals: a stderr line with the stdout prefix or
/// our browser helper's marker (a JSON string) and a valid URL. Returns the stdout line that
/// carries it to [`stdout_signal`]; other lines, and malformed URLs, give `None`.
pub(crate) fn stderr_sign_in(line: &str) -> Option<String> {
    let line = line.strip_suffix('\r').unwrap_or(line);
    if line.len() > AUTH_BROWSER_MARKER.len().max(AUTH_STDOUT_PREFIX.len()) + MAX_AUTH_URL + 2 {
        return None;
    }
    let url = if let Some(url) = line.strip_prefix(AUTH_STDOUT_PREFIX) {
        url.to_owned()
    } else {
        serde_json::from_str::<String>(line.strip_prefix(AUTH_BROWSER_MARKER)?).ok()?
    };
    is_authorization_url(&url).then(|| format!("{AUTH_STDOUT_PREFIX}{url}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Value {
        json!({"configOptions": [
            {"id": "model", "category": "model", "type": "select", "currentValue": "gemini-3.1-pro",
             "options": [{"value": "gemini-4-argon", "name": "Gemini 4 Argon"},
                         {"value": "gemini-3.8-flash", "name": "Gemini 3.8 Flash"},
                         {"value": "gemini-3.1-pro", "name": "Gemini 3.1 Pro"}]},
            {"id": "thought_level", "category": "thought_level", "type": "select", "currentValue": "low",
             "options": [{"value": "low", "name": "Low"}, {"value": "high", "name": "High"}]}
        ]})
    }

    #[test]
    fn model_switch_follows_t3() {
        let s = setup();
        assert_eq!(
            model_switch(&s, "gemini-3.8-flash", None),
            Ok(Some(("model".into(), "gemini-3.8-flash".into())))
        );
        assert_eq!(model_switch(&s, "gemini-3.1-pro", None), Ok(None));
        assert_eq!(model_switch(&s, DEFAULT_MODEL, None), Ok(None));
        assert_eq!(model_switch(&s, "", None), Ok(None));
        // A 1.3 id of a listed family passes through.
        assert_eq!(
            model_switch(&s, "gemini-3.8-flash-high", None),
            Ok(Some(("model".into(), "gemini-3.8-flash-high".into())))
        );
        assert!(model_switch(&s, "claude-x", None).is_err());
        // `resolveAntigravityModel`: the default selection takes the catalog's default when
        // the agent lists it or its family, else keeps the session's model.
        assert_eq!(
            model_switch(&s, DEFAULT_MODEL, Some("gemini-4-argon")),
            Ok(Some(("model".into(), "gemini-4-argon".into())))
        );
        assert_eq!(
            model_switch(&s, "", Some("gemini-3.8-flash-high")),
            Ok(Some(("model".into(), "gemini-3.8-flash-high".into())))
        );
        assert_eq!(model_switch(&s, "", Some("gemini-9")), Ok(None));
    }

    /// The version comes from this check's `--version`, never from an earlier one: a new
    /// binary on `PATH` shows its own version, and a missing one shows none. The entry never
    /// offers an install.
    #[test]
    fn version_follows_the_binary_on_path() {
        let settings = AntigravitySettings::from_instance(Some(&json!({"enabled": true})));
        let old = Observed {
            version: Some("1.5.4".into()),
            ..Observed::default()
        };
        let agy = || Ok(PathBuf::from("/usr/local/bin/agy"));
        let next = check(&settings, &old, agy(), cli_version("1.5.13\n"));
        assert_eq!(next.version.as_deref(), Some("1.5.13"));
        assert_eq!(check(&settings, &old, agy(), None).version, None);
        let missing = check(&settings, &old, Err("gone".into()), Some("1.5.13".into()));
        assert_eq!(missing.version, None);
        assert_eq!(cli_version("not a version"), None);
        let entry = entry(
            "antigravity",
            &settings,
            &next,
            "2026-11-20T00:00:00.000Z",
            None,
        );
        assert_eq!(entry["version"], "1.5.13");
        assert_eq!(entry["setup"]["canInstall"], false);
    }

    /// A health check that finds no account opens a session; the session makes the entry
    /// ready with its models, keeps the `--version` version, and stops the next check's load.
    #[test]
    fn health_check_loads_models_until_the_account_is_known() {
        let settings = AntigravitySettings::from_instance(Some(&json!({"enabled": true})));
        let agy = || Ok(PathBuf::from("/usr/local/bin/agy"));
        let checked = check(
            &settings,
            &Observed::default(),
            agy(),
            cli_version("1.5.14\n"),
        );
        assert!(needs_session(&checked));
        let initialize =
            json!({"agentInfo": {"name": "Antigravity ACP Server", "version": "0.0.0"}});
        let ready = session_started(&checked, &initialize, &setup(), None);
        assert!(!needs_session(&ready));
        let entry = entry(
            "antigravity",
            &settings,
            &ready,
            "2026-11-23T00:00:00.000Z",
            None,
        );
        assert_eq!(entry["status"], "ready");
        assert_eq!(entry["auth"]["status"], "authenticated");
        assert_eq!(entry["version"], "1.5.14");
        assert!(entry.get("message").is_none());
        assert_eq!(
            entry["models"],
            json!(models_from_session(&setup(), &Default::default()))
        );
        let again = check(&settings, &ready, agy(), cli_version("1.5.14\n"));
        assert!(!needs_session(&again));
        assert_eq!(again.models, ready.models);
        // No executable or a configuration problem: nothing to start.
        assert!(!needs_session(&check(
            &settings,
            &Observed::default(),
            Err("gone".into()),
            None
        )));
        let no_key = AntigravitySettings::from_instance(Some(&json!({
            "enabled": true, "config": {"authMethod": "gemini-api-key"}
        })));
        assert!(!needs_session(&check(
            &no_key,
            &Observed::default(),
            agy(),
            None
        )));
    }

    #[test]
    fn client_name_depends_on_the_version() {
        assert_eq!(client_info(None), ("zed".into(), "0.0.0".into()));
        assert_eq!(client_info(Some("1.5.0")), ("zed".into(), "0.0.0".into()));
        assert_eq!(client_info(Some("1.5.4")).0, "t3-code");
    }

    #[test]
    fn session_meta_appends_linking_when_offered() {
        let offers = json!({"agentInfo": {"version": "1.5.4"},
            "agentCapabilities": {"_meta": {"antigravity": {"systemPrompt": {"append": true}}}}});
        let meta = session_meta(&offers)
            .map(|m| m.to_line())
            .unwrap_or_default();
        assert!(
            meta.starts_with(r#"{"antigravity":{"systemPrompt":{"append":"<pull_request_linking>"#)
        );
        assert!(session_meta(&json!({"agentInfo": {"version": "1.5.4"}})).is_none());
        let old = session_meta(&json!({"agentInfo": {"version": "1.4.3"}})).map(|m| m.to_line());
        assert_eq!(
            old.as_deref(),
            Some(r#"{"antigravity":{"disabledTools":["run_workflow"]}}"#)
        );
    }

    #[test]
    fn settings_never_print_the_key() {
        let s = AntigravitySettings::from_instance(Some(&json!({
            "driver": "antigravity", "enabled": true,
            "config": {"authMethod": "gemini-api-key", "apiKey": "sk-secret-value"}
        })));
        assert_eq!(s.api_key, "sk-secret-value");
        assert!(s.config_issue().is_none());
        assert!(!format!("{s:?}").contains("sk-secret"));
        let none = AntigravitySettings::from_instance(Some(&json!({
            "driver": "antigravity", "enabled": true, "config": {"authMethod": "gemini-api-key"}
        })));
        assert!(none.config_issue().is_some());
    }

    // ---- ports of `AntigravityProvider.test.ts` ------------------------------------------

    /// T3's `commands` and `expectedCommands`.
    fn t3_commands() -> (Value, Value) {
        (
            json!([{"name": "plan", "description": "Create a plan",
                    "input": {"type": "text", "hint": "What to plan"}},
                   {"name": "logout", "description": "Sign out of Google"}]),
            json!([{"name": "plan", "description": "Create a plan", "input": {"hint": "What to plan"}},
                   {"name": "logout", "description": "Sign out of Google"}]),
        )
    }

    fn signed_in(cwd: &str) -> Observed {
        let initialize = json!({"agentInfo": {"name": "antigravity-acp", "version": "1.5.14"}});
        session_started(
            &Observed::default(),
            &initialize,
            &setup(),
            Some((cwd, "2026-11-23T00:00:00.000Z")),
        )
    }

    fn workspace_commands(observed: &Observed, cwd: &str) -> Value {
        observed
            .workspaces
            .iter()
            .find(|w| w["cwd"] == cwd)
            .map_or(Value::Null, |w| w["slashCommands"].clone())
    }

    /// "offers each model the thinking levels it reported when selected".
    #[test]
    fn offers_each_model_the_thinking_levels_it_reported_when_selected() {
        let thinking = |current: &str| {
            json!({"id": "thinking_level", "name": "Thinking Level", "category": "thought_level",
                   "type": "select", "currentValue": current,
                   "options": [{"value": "low", "name": "Low"}, {"value": "high", "name": "High"}]})
        };
        let setup = json!({"configOptions": [
            {"id": "model", "category": "model", "type": "select", "currentValue": "gemini",
             "options": [{"value": "gemini", "name": "Gemini"}, {"value": "claude", "name": "Claude"},
                         {"value": "plain", "name": "Plain"}, {"value": "unseen", "name": "Unseen"}]},
            thinking("high")
        ]});
        let levels = std::collections::BTreeMap::from([
            ("claude".to_owned(), Some(thinking("low"))),
            ("plain".to_owned(), None),
        ]);
        let models = models_from_session(&setup, &levels);
        let thinking_of = |slug: &str| {
            models.iter().find(|m| m["slug"] == slug).unwrap()["capabilities"]["optionDescriptors"]
                [0]
            .clone()
        };
        assert_eq!(thinking_of("gemini")["id"], "thinking_level");
        assert_eq!(thinking_of("gemini")["currentValue"], "high");
        assert_eq!(thinking_of("claude")["currentValue"], "low");
        assert_eq!(thinking_of("plain"), Value::Null);
        assert_eq!(thinking_of("unseen")["id"], "thinking_level");
        assert!(thinking_of("unseen").get("currentValue").is_none());
    }

    /// "publishes session metadata and native commands without another health probe".
    #[test]
    fn publishes_session_metadata_and_native_commands() {
        let (commands, expected) = t3_commands();
        let ready = signed_in("/workspace");
        let next = available_commands(
            &ready,
            &commands,
            Some("/workspace"),
            "2026-11-23T00:00:01.000Z",
        );
        assert_eq!(next.status, Some("ready"));
        assert!(next.authenticated);
        assert_eq!(Value::Array(next.slash_commands.clone()), expected);
        assert_eq!(workspace_commands(&next, "/workspace"), expected);
    }

    /// "keeps a workspace's native commands when the catalog reports its own".
    #[test]
    fn keeps_a_workspaces_native_commands_when_the_catalog_reports_its_own() {
        let (commands, expected) = t3_commands();
        let ready = signed_in("/workspace");
        let next = available_commands(
            &ready,
            &commands,
            Some("/workspace"),
            "2026-11-23T00:00:01.000Z",
        );
        // The catalog probe runs in a scratch directory and reports no cwd.
        let rest = json!(commands.as_array().unwrap()[1..]);
        let next = available_commands(&next, &rest, None, "2026-11-23T00:00:02.000Z");
        assert_eq!(workspace_commands(&next, "/workspace"), expected);
        assert_eq!(
            Value::Array(next.slash_commands),
            json!(expected.as_array().unwrap()[1..])
        );
    }

    /// "clears all account metadata on sign-out and authentication failure", for the
    /// authentication failure (this server has no sign-out flow).
    #[test]
    fn clears_all_account_metadata_on_authentication_failure() {
        let settings = AntigravitySettings::from_instance(Some(&json!({"enabled": true,
            "config": {"authMethod": "gemini-api-key", "apiKey": "k"}})));
        let (commands, _) = t3_commands();
        let ready = available_commands(
            &signed_in("/workspace"),
            &commands,
            Some("/workspace"),
            "2026-11-23T00:00:01.000Z",
        );
        let cleared = auth_required(&settings, &ready);
        let shown = entry(
            "antigravity",
            &settings,
            &cleared,
            "2026-11-23T00:00:02.000Z",
            None,
        );
        assert_eq!(shown["installed"], true);
        assert_eq!(shown["status"], "warning");
        assert_eq!(
            shown["auth"],
            json!({"status": "unauthenticated", "type": "gemini-api-key", "label": "Gemini API key"})
        );
        assert_eq!(
            shown["message"],
            "Connect with Gemini API key to use Antigravity and load models."
        );
        for key in ["models", "slashCommands", "skills", "workspaceSnapshots"] {
            assert_eq!(shown[key], json!([]), "{key}");
        }
        assert_eq!(shown["supportsTextGeneration"], false);
        // Later reports from a session do not restore the account's catalog.
        let after = available_commands(
            &cleared,
            &commands,
            Some("/workspace"),
            "2026-11-23T00:00:03.000Z",
        );
        let after = config_options_updated(&after, &setup()["configOptions"]);
        assert_eq!(workspace_commands(&after, "/workspace"), Value::Null);
        assert!(after.models.is_empty());
        // A health check keeps it signed out and starts no session.
        let checked = check(
            &settings,
            &after,
            Ok(PathBuf::from("/usr/local/bin/agy")),
            None,
        );
        let rechecked = entry(
            "antigravity",
            &settings,
            &checked,
            "2026-11-23T00:00:04.000Z",
            None,
        );
        assert_eq!(rechecked["auth"]["status"], "unauthenticated");
        assert_eq!(
            rechecked["message"],
            "Connect with Gemini API key to use Antigravity and load models."
        );
        assert!(!needs_session(&checked));
    }

    /// T3's `observeThinkingLevels` keeps what each model reported until sign-out, also for
    /// a model a later full model list no longer offers.
    #[test]
    fn thinking_levels_stay_until_sign_out() {
        let mut previous = Observed {
            authenticated: true,
            ..Observed::default()
        };
        previous
            .thinking_levels
            .insert("gemini-retired".into(), None);
        let options = &setup()["configOptions"];
        let next = config_options_updated(&previous, options);
        assert!(next.thinking_levels.contains_key("gemini-retired"));
        let started = session_started(&previous, &json!({}), &setup(), None);
        assert!(started.thinking_levels.contains_key("gemini-retired"));
        let signed_out = auth_required(
            &AntigravitySettings::from_instance(Some(&json!({"enabled": true}))),
            &started,
        );
        assert!(signed_out.thinking_levels.is_empty());
    }
}
