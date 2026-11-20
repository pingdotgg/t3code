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

/// `applyAntigravityAcpModelSelection` with no catalog default: the `model` config option and
/// value to set, `None` when the session keeps its model, or the refusal T3 gives.
pub(crate) fn model_switch(setup: &Value, model: &str) -> Result<Option<(String, String)>, String> {
    let (config_id, current, options) = model_options(setup);
    let explicit = !model.is_empty() && model != DEFAULT_MODEL;
    if !explicit {
        return Ok(None);
    }
    let Some(config_id) = config_id else {
        return Ok(None);
    };
    if current.as_deref() == Some(model) {
        return Ok(None);
    }
    if options.iter().any(|o| o == model) {
        return Ok(Some((config_id, model.to_owned())));
    }
    // `legacyAntigravityFamily`: 1.3 ids such as `gemini-3.8-flash-high` still work.
    if options
        .iter()
        .any(|family| model.starts_with(&format!("{family}-")))
    {
        return Ok(Some((config_id, model.to_owned())));
    }
    Err(format!(
        "Antigravity model '{model}' is unavailable for this Google account. Select an available model."
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
};

// ---- the `ServerProvider` entry -----------------------------------------------------------

/// What the entry shows beyond the settings (`makeAntigravityProvider`'s draft).
#[derive(Clone, Debug, Default)]
pub(crate) struct Observed {
    pub installed: bool,
    pub version: Option<String>,
    /// `null` until checked; then T3's status of the last check or session.
    pub status: Option<&'static str>,
    pub authenticated: bool,
    pub message: Option<String>,
    pub models: Vec<Value>,
}

/// `buildServerProvider` + `withInstanceIdentity` for Antigravity.
pub(crate) fn entry(
    instance_id: &str,
    settings: &AntigravitySettings,
    observed: &Observed,
    checked_at: &str,
) -> Value {
    let auth = if observed.authenticated {
        json!({"status": "authenticated", "type": settings.auth_method, "label": settings.auth_label()})
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
        "Antigravity is disabled in T3 Code settings.".into()
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
    entry.insert("models".into(), Value::Array(observed.models.clone()));
    entry.insert("slashCommands".into(), json!([]));
    entry.insert("skills".into(), json!([]));
    // Orbit installs and updates every provider CLI and owns `PATH`; this server installs
    // nothing (Nick, 2026-11-20). T3 says `canInstall: true` for its managed runtime.
    entry.insert(
        "setup".into(),
        json!({"canAuthenticate": true, "canInstall": false}),
    );
    entry.insert("supportsConversationRollback".into(), json!(true));
    entry.insert("supportsTextGeneration".into(), json!(false));
    entry.insert("workspaceSnapshots".into(), json!([]));
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

/// `checkAntigravityProvider` without starting the agent (T3's probe never starts it: it
/// unpacks about 1 GB per launch): the executable resolves and the sign-in is configured.
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
    }
    next.status = Some(match (&error, next.authenticated) {
        (Some(_), _) => "error",
        (None, true) => "ready",
        (None, false) => "warning",
    });
    next.message = error.or_else(|| {
        (!next.authenticated).then(|| {
            if settings.uses_credentials() {
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

/// `buildAntigravityModelsFromSession`: the `model` option's values (or the session's
/// `models`), the current one the default with the `antigravity-default` alias. Thinking
/// levels are not reported per model here (`capabilities` stay empty).
pub(crate) fn models_from_session(setup: &Value) -> Vec<Value> {
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
        let mut model = json!({
            "slug": value,
            "name": label,
            "isCustom": false,
            "capabilities": {"optionDescriptors": []},
        });
        if current.as_deref() == Some(value.as_str()) {
            model["isDefault"] = json!(true);
            model["aliases"] = json!([DEFAULT_MODEL]);
        }
        out.push(model);
    }
    out
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
            model_switch(&s, "gemini-3.8-flash"),
            Ok(Some(("model".into(), "gemini-3.8-flash".into())))
        );
        assert_eq!(model_switch(&s, "gemini-3.1-pro"), Ok(None));
        assert_eq!(model_switch(&s, DEFAULT_MODEL), Ok(None));
        assert_eq!(model_switch(&s, ""), Ok(None));
        // A 1.3 id of a listed family passes through.
        assert_eq!(
            model_switch(&s, "gemini-3.8-flash-high"),
            Ok(Some(("model".into(), "gemini-3.8-flash-high".into())))
        );
        assert!(model_switch(&s, "claude-x").is_err());
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
        let entry = entry("antigravity", &settings, &next, "2026-11-20T00:00:00.000Z");
        assert_eq!(entry["version"], "1.5.13");
        assert_eq!(entry["setup"]["canInstall"], false);
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
}
