//! Grok's `ServerProvider` entry, probed as T3 probes it (`checkGrokProviderStatus` in
//! `packages/provider-grok/src/server/status.ts`, with `buildServerProvider` and
//! `withInstanceIdentity` from `provider-core`).
//!
//! The probe runs, in order: `grok --version` (10 s), `grok models` (10 s; once more when it
//! says "not authenticated" and no API key is set), `grok inspect --json` in the workspace
//! (4 s) for skills, and an ACP `initialize` on `grok agent stdio` (20 s) for models and slash
//! commands. It never sends `authenticate` or `session/new`. A timeout may be lengthened
//! with `T3CODE_GROK_PROBE_TIMEOUT_MS`, never shortened.
//!
//! Not ported, on purpose: `readGrokAccount` (it reads Grok's credentials file and calls
//! xAI's billing API, which this server must never do) and the version advisory (it asks a
//! package registry for the latest version).

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Map, Value, json};

use crate::probe::{CommandError, CommandOutput, spawn_and_collect};
use conn_provider_support::instance::{InstanceEnv, InstanceEnvelope, trimmed};

pub(crate) const DRIVER: &str = "grok";
const DISPLAY_NAME: &str = "Grok";
/// `GROK_DEFAULT_MODEL_SLUG`.
pub(crate) const DEFAULT_MODEL_SLUG: &str = "grok-build";
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// `AUTH_PROBE_TIMEOUT_MS`.
const MODELS_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const SKILLS_PROBE_TIMEOUT: Duration = Duration::from_secs(4);
const ACP_INITIALIZE_TIMEOUT: Duration = Duration::from_secs(20);
const API_KEY_ENV: &str = "XAI_API_KEY";
const EFFORT_RANK: [&str; 7] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/// `GrokSettings` as the instance's `providerInstances` entry gives it.
#[derive(Clone, Debug, PartialEq)]
pub struct GrokSettings {
    pub enabled: bool,
    /// `binaryPath`: trimmed, `grok` when empty.
    pub binary_path: String,
    /// `customModels`, as stored.
    pub custom_models: Vec<Value>,
    /// The instance's `displayName` and `accentColor` (`withInstanceIdentity`).
    pub display_name: Option<String>,
    pub accent_color: Option<String>,
    /// The instance's `environment` entries with a value, in order. `Debug` prints names only.
    pub environment: InstanceEnv,
}

impl Default for GrokSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            binary_path: DRIVER.into(),
            custom_models: Vec::new(),
            display_name: None,
            accent_color: None,
            environment: InstanceEnv::default(),
        }
    }
}

impl GrokSettings {
    /// From the `providerInstances[id]` envelope (`None`: the default instance, unconfigured).
    /// `resolveProviderInstanceEnabled`, with Grok's default (off).
    pub fn from_instance(entry: Option<&Value>) -> Self {
        let envelope = InstanceEnvelope::parse(entry, false);
        Self {
            enabled: envelope.enabled,
            binary_path: envelope
                .config_str("binaryPath")
                .unwrap_or_else(|| DRIVER.into()),
            custom_models: envelope.config["customModels"]
                .as_array()
                .cloned()
                .unwrap_or_default(),
            display_name: envelope.display_name,
            accent_color: envelope.accent_color,
            environment: envelope.environment,
        }
    }
}

/// `mergeProviderInstanceEnvironment`: the server's environment with the instance's entries.
pub(crate) fn merge_environment(
    base: &[(String, String)],
    instance: &[(String, String)],
) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = base.to_vec();
    for (name, value) in instance {
        set_var(&mut env, name, value);
    }
    env
}

fn set_var(env: &mut Vec<(String, String)>, name: &str, value: &str) {
    if let Some(slot) = env.iter_mut().find(|(k, _)| k == name) {
        slot.1 = value.to_owned();
    } else {
        env.push((name.to_owned(), value.to_owned()));
    }
}

/// `grokProbeEnvironment`: `MISE_OFFLINE=1` (`providerProbeEnvironment`) and
/// `GROK_DISABLE_AUTOUPDATER=1` on top of the merged environment.
pub(crate) fn probe_environment(merged: &[(String, String)]) -> Vec<(String, String)> {
    let mut env = merged.to_vec();
    set_var(&mut env, "MISE_OFFLINE", "1");
    set_var(&mut env, "GROK_DISABLE_AUTOUPDATER", "1");
    env
}

/// `resolveProviderProbeTimeoutMs("grok", …)`: an override only lengthens a timeout.
fn probe_timeout(default: Duration, environment: &[(String, String)]) -> Duration {
    let default_ms = u64::try_from(default.as_millis()).unwrap_or(u64::MAX);
    environment
        .iter()
        .find(|(k, _)| k == "T3CODE_GROK_PROBE_TIMEOUT_MS")
        .and_then(|(_, v)| v.parse::<u64>().ok())
        .filter(|ms| *ms > default_ms && *ms <= 2_147_483_647)
        .map_or(default, Duration::from_millis)
}

fn empty_capabilities() -> Value {
    json!({"optionDescriptors": []})
}

/// `GROK_BUILT_IN_MODELS`.
fn built_in_models() -> Vec<Value> {
    vec![json!({
        "slug": DEFAULT_MODEL_SLUG,
        "name": "Grok Build",
        "isCustom": false,
        "capabilities": empty_capabilities(),
    })]
}

/// `readCustomModelEntries`: slug and name, trimmed; the first of each slug.
fn custom_model_entries(custom: &[Value]) -> Vec<(String, String, Option<Value>)> {
    let mut seen = std::collections::HashSet::new();
    let mut entries = Vec::new();
    for raw in custom {
        let (slug, name, capabilities) = match raw {
            Value::String(s) => (Some(s.trim().to_owned()), None, None),
            Value::Object(o) => (
                o.get("slug").and_then(trimmed),
                o.get("name").and_then(trimmed),
                o.get("capabilities")
                    .filter(|c| !c.is_null())
                    .map(|c| json!({"optionDescriptors": c.get("optionDescriptors").cloned().unwrap_or_else(|| json!([]))})),
            ),
            _ => continue,
        };
        let Some(slug) = slug.filter(|s| !s.is_empty()) else {
            continue;
        };
        if !seen.insert(slug.clone()) {
            continue;
        }
        let name = name.unwrap_or_else(|| slug.clone());
        entries.push((slug, name, capabilities));
    }
    entries
}

/// `providerModelsFromSettings` with `EMPTY_CAPABILITIES` for custom models.
fn models_from_settings(built_in: Vec<Value>, custom: &[Value]) -> Vec<Value> {
    let entries = custom_model_entries(custom);
    if entries.is_empty() {
        return built_in;
    }
    let mut models: Vec<Value> = built_in
        .into_iter()
        .map(|mut model| {
            let slug = model["slug"].as_str().unwrap_or("").to_owned();
            if let Some((_, name, _)) = entries.iter().find(|(s, n, _)| *s == slug && n != s)
                && let Some(object) = model.as_object_mut()
            {
                object.remove("shortName");
                object.insert("name".into(), json!(name));
            }
            model
        })
        .collect();
    let mut seen: std::collections::HashSet<String> = models
        .iter()
        .filter_map(|m| m["slug"].as_str().map(str::to_owned))
        .collect();
    for (slug, name, capabilities) in entries {
        if !seen.insert(slug.clone()) {
            continue;
        }
        models.push(json!({
            "slug": slug,
            "name": name,
            "isCustom": true,
            "capabilities": capabilities.unwrap_or_else(empty_capabilities),
        }));
    }
    models
}

/// `resolveGrokAcpBaseModelId`: Grok has no slug aliases.
fn base_model_id(model: &str) -> String {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        DEFAULT_MODEL_SLUG.into()
    } else {
        trimmed.into()
    }
}

/// `isValidGrokReasoningEffortToken`: `^[a-z0-9][a-z0-9._-]{0,31}$`, any case.
pub(crate) fn is_effort_token(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && value.len() <= 32
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// The efforts a model offers (`grokReasoningOptionsFromModel(...).options`).
pub(crate) fn offered_efforts(model: &Value) -> Vec<String> {
    model_capabilities(model)["optionDescriptors"][0]["options"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|o| o["id"].as_str().map(str::to_owned))
        .collect()
}

/// `grokReasoningOptionsFromModel` + `buildGrokModelCapabilities`.
fn model_capabilities(model: &Value) -> Value {
    let meta = &model["_meta"];
    if !meta.is_object() || meta["supportsReasoningEffort"] == false {
        return empty_capabilities();
    }
    let current = trimmed(&meta["reasoningEffort"]);
    struct Opt {
        value: String,
        label: String,
        description: Option<String>,
        default: bool,
    }
    let mut options: Vec<Opt> = Vec::new();
    for entry in meta["reasoningEfforts"].as_array().into_iter().flatten() {
        if !entry.is_object() {
            continue;
        }
        let raw_value = trimmed(&entry["value"]);
        let raw_id = trimmed(&entry["id"]);
        let value = match (raw_value, raw_id) {
            (Some(v), _) if is_effort_token(&v) => v,
            (_, Some(id)) if is_effort_token(&id) => id,
            _ => continue,
        };
        if options.iter().any(|o| o.value == value) {
            continue;
        }
        options.push(Opt {
            label: trimmed(&entry["label"]).unwrap_or_else(|| value.clone()),
            description: trimmed(&entry["description"]),
            default: entry["default"] == true || entry["isDefault"] == true,
            value,
        });
    }
    let current = current.filter(|c| options.iter().any(|o| &o.value == c));
    let selected_default = options
        .iter()
        .filter(|o| o.default)
        .find(|o| Some(&o.value) == current.as_ref())
        .or_else(|| options.iter().find(|o| o.default))
        .map(|o| o.value.clone());
    let rank = |o: &Opt| EFFORT_RANK.iter().position(|r| *r == o.value);
    if options.iter().all(|o| rank(o).is_some()) {
        options.sort_by_key(|o| rank(o));
    }
    if options.is_empty() {
        return empty_capabilities();
    }
    let current_value = current.or_else(|| selected_default.clone());
    let descriptor_options: Vec<Value> = options
        .iter()
        .map(|o| {
            let mut entry = Map::new();
            entry.insert("id".into(), json!(o.value));
            entry.insert("label".into(), json!(o.label));
            if let Some(d) = &o.description {
                entry.insert("description".into(), json!(d));
            }
            if Some(&o.value) == selected_default.as_ref() {
                entry.insert("isDefault".into(), json!(true));
            }
            Value::Object(entry)
        })
        .collect();
    let mut descriptor = Map::new();
    descriptor.insert("id".into(), json!("reasoningEffort"));
    descriptor.insert("label".into(), json!("Reasoning"));
    descriptor.insert("type".into(), json!("select"));
    descriptor.insert("options".into(), Value::Array(descriptor_options));
    if let Some(current) = current_value {
        descriptor.insert("currentValue".into(), json!(current));
    }
    json!({"optionDescriptors": [Value::Object(descriptor)]})
}

/// `isSessionModelState` on `_meta.modelState` (`sessionModelStateFromInitialize`).
fn is_model_state(state: &Value) -> bool {
    let meta_ok = |v: &Value| v.is_null() || v.is_object();
    state["currentModelId"].is_string()
        && state.get("_meta").is_none_or(meta_ok)
        && state["availableModels"].as_array().is_some_and(|models| {
            models.iter().all(|m| {
                m["modelId"].is_string()
                    && m["name"].is_string()
                    && m.get("description")
                        .is_none_or(|d| d.is_null() || d.is_string())
                    && m.get("_meta").is_none_or(meta_ok)
            })
        })
}

/// `buildGrokModelsFromSessionModelState(sessionModelStateFromInitialize(initialized))`.
pub(crate) fn models_from_initialize(initialized: &Value) -> Vec<Value> {
    let state = &initialized["_meta"]["modelState"];
    if !initialized["_meta"].is_object() || !is_model_state(state) {
        return Vec::new();
    }
    let current = state["currentModelId"].as_str().unwrap_or("").trim();
    let mut seen = std::collections::HashSet::new();
    let mut models = Vec::new();
    for model in state["availableModels"].as_array().into_iter().flatten() {
        let model_id = model["modelId"].as_str().unwrap_or("");
        let slug = base_model_id(model_id);
        if !seen.insert(slug.clone()) {
            continue;
        }
        let name = model["name"].as_str().unwrap_or("").trim();
        let mut entry = Map::new();
        entry.insert("slug".into(), json!(slug));
        entry.insert(
            "name".into(),
            json!(if name.is_empty() { slug.as_str() } else { name }),
        );
        entry.insert("isCustom".into(), json!(false));
        if model_id.trim() == current {
            entry.insert("isDefault".into(), json!(true));
        }
        entry.insert("capabilities".into(), model_capabilities(model));
        models.push(Value::Object(entry));
    }
    models
}

/// `COMPACT_SLASH_COMMAND`.
fn compact_command() -> Value {
    json!({"name": "compact", "description": "Summarize the conversation and reduce context usage"})
}

/// `grokSlashCommandsFromInitialize`.
pub(crate) fn slash_commands_from_initialize(initialized: &Value) -> Vec<Value> {
    let mut commands: Vec<(String, Value)> = vec![("compact".into(), compact_command())];
    for entry in initialized["_meta"]["availableCommands"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let (Some(name), Some(description)) =
            (entry["name"].as_str(), entry["description"].as_str())
        else {
            continue;
        };
        let input = entry.get("input").unwrap_or(&Value::Null);
        // `input: optional(NullOr(Struct({ hint: String })))`.
        let hint = match input {
            Value::Null => None,
            Value::Object(o) => match o.get("hint") {
                Some(Value::String(h)) => Some(h.trim().to_owned()),
                _ => continue,
            },
            _ => continue,
        };
        let name = name.trim();
        if name.is_empty() || name.eq_ignore_ascii_case("always-approve") {
            continue;
        }
        // Grok advertises /context, but its ACP handler completes without output.
        if name.eq_ignore_ascii_case("context") {
            continue;
        }
        let mut command = Map::new();
        command.insert("name".into(), json!(name));
        let description = description.trim();
        if !description.is_empty() {
            command.insert("description".into(), json!(description));
        }
        if let Some(hint) = hint.filter(|h| !h.is_empty()) {
            command.insert("input".into(), json!({"hint": hint}));
        }
        let command = Value::Object(command);
        if let Some(slot) = commands.iter_mut().find(|(n, _)| n == name) {
            slot.1 = command;
        } else {
            commands.push((name.to_owned(), command));
        }
    }
    commands.into_iter().map(|(_, c)| c).collect()
}

/// `GrokModelsCliOutput`.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct CliModels {
    pub authenticated: Option<bool>,
    pub models: Vec<Value>,
}

/// `displayNameFromGrokModelSlug`.
fn display_name_from_slug(slug: &str) -> String {
    slug.split(['-', '_'])
        .map(|part| {
            if part.eq_ignore_ascii_case("grok") {
                "Grok"
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// `parseGrokModelsCliOutput`: the login line and the bullet list of `grok models`.
pub(crate) fn parse_models_output(output: &str) -> CliModels {
    let lower = output.to_lowercase();
    let authenticated = if lower.contains("you are logged in") {
        Some(true)
    } else if lower.contains("not authenticated") || lower.contains("not logged in") {
        Some(false)
    } else {
        None
    };
    let mut seen = std::collections::HashSet::new();
    let mut models = Vec::new();
    for line in output.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        // `^\s*[*-]\s+(\S+)(.*)$`
        let rest = line.trim_start();
        let Some(after) = rest.strip_prefix(['*', '-']) else {
            continue;
        };
        if !after.starts_with(char::is_whitespace) {
            continue;
        }
        let after = after.trim_start();
        let token_end = after.find(char::is_whitespace).unwrap_or(after.len());
        let (token, tail) = after.split_at(token_end);
        if token.is_empty() {
            continue;
        }
        let slug = base_model_id(token);
        if !seen.insert(slug.clone()) {
            continue;
        }
        let mut entry = Map::new();
        entry.insert("slug".into(), json!(slug));
        entry.insert("name".into(), json!(display_name_from_slug(&slug)));
        entry.insert("isCustom".into(), json!(false));
        if tail.to_lowercase().contains("(default)") {
            entry.insert("isDefault".into(), json!(true));
        }
        entry.insert("capabilities".into(), empty_capabilities());
        models.push(Value::Object(entry));
    }
    CliModels {
        authenticated,
        models,
    }
}

/// `parseGenericCliVersion` on a clean exit (`parseCliVersionResult`).
pub(crate) fn parse_version(result: &CommandOutput) -> Option<String> {
    if result.code != 0 {
        return None;
    }
    let text = format!("{}\n{}", result.stdout, result.stderr);
    // `\bv?(\d+\.\d+\.\d+)\b`
    let bytes = text.as_bytes();
    let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let digits = |from: usize| {
        bytes
            .get(from..)
            .map_or(0, |s| s.iter().take_while(|b| b.is_ascii_digit()).count())
    };
    for start in 0..bytes.len() {
        let prev = start.checked_sub(1).and_then(|i| bytes.get(i)).copied();
        if prev.is_some_and(is_word) {
            continue;
        }
        let mut at = start;
        if bytes.get(at) == Some(&b'v') {
            at += 1;
        }
        let begin = at;
        let mut ok = true;
        for part in 0..3 {
            let n = digits(at);
            if n == 0 {
                ok = false;
                break;
            }
            at += n;
            if part < 2 {
                if bytes.get(at) != Some(&b'.') {
                    ok = false;
                    break;
                }
                at += 1;
            }
        }
        if !ok || bytes.get(at).copied().is_some_and(is_word) {
            continue;
        }
        return text.get(begin..at).map(str::to_owned);
    }
    None
}

/// `decodeGrokInspectSkills`: `grok inspect --json` → skills sorted by name.
pub(crate) fn decode_skills(stdout: &str) -> Option<Vec<Value>> {
    let parsed: Value = serde_json::from_str(stdout).ok()?;
    let entries = parsed.as_object()?.get("skills")?.as_array()?;
    let mut by_name: Vec<(String, Value)> = Vec::new();
    for entry in entries {
        let Some(record) = entry.as_object() else {
            continue;
        };
        let name = record
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        let source = record.get("source").filter(|s| s.is_object());
        let path = source
            .and_then(|s| s["path"].as_str())
            .map(str::trim)
            .unwrap_or("");
        if name.is_empty() || path.is_empty() {
            continue;
        }
        let scope = source
            .and_then(|s| s["type"].as_str())
            .map(str::trim)
            .unwrap_or("");
        let description = record
            .get("description")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        let mut skill = Map::new();
        skill.insert("name".into(), json!(name));
        skill.insert("path".into(), json!(path));
        skill.insert(
            "enabled".into(),
            json!(record.get("userInvocable") != Some(&Value::Bool(false))),
        );
        if !scope.is_empty() {
            skill.insert("scope".into(), json!(scope));
        }
        if !description.is_empty() {
            skill.insert("description".into(), json!(description));
        }
        let skill = Value::Object(skill);
        if let Some(slot) = by_name.iter_mut().find(|(n, _)| n == name) {
            slot.1 = skill;
        } else {
            by_name.push((name.to_owned(), skill));
        }
    }
    // `localeCompare`; skill names are ASCII in practice, so a case-aware byte order serves.
    by_name.sort_by(|(a, _), (b, _)| {
        a.to_lowercase()
            .cmp(&b.to_lowercase())
            .then_with(|| b.cmp(a))
    });
    Some(by_name.into_iter().map(|(_, s)| s).collect())
}

/// `ProviderProbeResult`.
struct Probe {
    installed: bool,
    version: Option<String>,
    status: &'static str,
    auth: Value,
    message: Option<String>,
}

/// `buildServerProvider` (Grok passes no driver, so no version advisory) and
/// `withInstanceIdentity`.
fn build_entry(
    instance_id: &str,
    settings: &GrokSettings,
    checked_at: &str,
    models: Vec<Value>,
    slash_commands: Vec<Value>,
    skills: Vec<Value>,
    probe: Probe,
) -> Value {
    let mut entry = Map::new();
    entry.insert("displayName".into(), json!(DISPLAY_NAME));
    entry.insert("supportsConversationRollback".into(), json!(false));
    entry.insert("showInteractionModeToggle".into(), json!(false));
    entry.insert(
        "supportedRuntimeModes".into(),
        json!(["approval-required", "auto", "full-access"]),
    );
    entry.insert("enabled".into(), json!(settings.enabled));
    entry.insert("installed".into(), json!(probe.installed));
    entry.insert("version".into(), json!(probe.version));
    entry.insert(
        "status".into(),
        json!(if settings.enabled {
            probe.status
        } else {
            "disabled"
        }),
    );
    entry.insert("auth".into(), probe.auth);
    entry.insert(
        "setup".into(),
        json!({"canAuthenticate": false, "canInstall": false}),
    );
    entry.insert("checkedAt".into(), json!(checked_at));
    if let Some(message) = probe.message {
        entry.insert("message".into(), json!(message));
    }
    entry.insert("models".into(), Value::Array(models));
    entry.insert("slashCommands".into(), Value::Array(slash_commands));
    entry.insert("skills".into(), Value::Array(skills));
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

fn unknown_auth() -> Value {
    json!({"status": "unknown"})
}

/// `buildInitialGrokProviderSnapshot`: the entry before the first probe completes.
pub(crate) fn initial_entry(instance_id: &str, settings: &GrokSettings, checked_at: &str) -> Value {
    let models = models_from_settings(built_in_models(), &settings.custom_models);
    let probe = if settings.enabled {
        Probe {
            installed: true,
            version: None,
            status: "warning",
            auth: unknown_auth(),
            message: Some("Checking Grok CLI availability...".into()),
        }
    } else {
        disabled_probe()
    };
    build_entry(
        instance_id,
        settings,
        checked_at,
        models,
        vec![],
        vec![],
        probe,
    )
}

fn disabled_probe() -> Probe {
    Probe {
        installed: false,
        version: None,
        status: "warning",
        auth: unknown_auth(),
        message: Some("Grok is disabled in T3 Code settings.".into()),
    }
}

/// What the probe needs from its host: where to run, and the ACP `initialize` call.
pub(crate) struct ProbeContext<'a> {
    /// The server's environment (`process.env`).
    pub base_env: &'a [(String, String)],
    /// The server's working folder (`process.cwd()`): `--version`, `models` and the ACP probe.
    pub server_cwd: &'a Path,
    /// The workspace for skills (`host.paths.cwd`).
    pub workspace_cwd: Option<PathBuf>,
}

/// `checkGrokProviderStatus`.
pub(crate) async fn check_status(
    instance_id: &str,
    settings: &GrokSettings,
    context: &ProbeContext<'_>,
    checked_at: &str,
) -> Value {
    let fallback_models = models_from_settings(built_in_models(), &settings.custom_models);
    if !settings.enabled {
        return build_entry(
            instance_id,
            settings,
            checked_at,
            fallback_models,
            vec![],
            vec![],
            disabled_probe(),
        );
    }
    // `processEnv`: the timeout override and the API key are read here, as T3 does; the
    // probes get it with the probe variables added.
    let merged = merge_environment(context.base_env, &settings.environment);
    let env = probe_environment(&merged);
    let has_api_key = merged
        .iter()
        .any(|(k, v)| k == API_KEY_ENV && !v.trim().is_empty());
    let binary = settings.binary_path.as_str();
    let fail = |installed: bool, version: Option<String>, message: &str| Probe {
        installed,
        version,
        status: "error",
        auth: unknown_auth(),
        message: Some(message.to_owned()),
    };

    let version_result = spawn_and_collect(
        binary,
        &["--version"],
        &env,
        Some(context.server_cwd),
        probe_timeout(VERSION_PROBE_TIMEOUT, &merged),
    )
    .await;
    let version_output = match version_result {
        Err(error) => {
            let missing = error == CommandError::NotFound;
            let message = if missing {
                "Grok CLI (`grok`) is not installed or not on PATH."
            } else {
                "Failed to execute Grok CLI health check."
            };
            let probe = fail(!missing, None, message);
            return build_entry(
                instance_id,
                settings,
                checked_at,
                fallback_models,
                vec![],
                vec![],
                probe,
            );
        }
        Ok(None) => {
            let probe = fail(
                true,
                None,
                "Grok CLI is installed but timed out while running `grok --version`.",
            );
            return build_entry(
                instance_id,
                settings,
                checked_at,
                fallback_models,
                vec![],
                vec![],
                probe,
            );
        }
        Ok(Some(output)) => output,
    };
    let version = parse_version(&version_output);
    if version_output.code != 0 {
        let probe = fail(true, version, "Grok CLI is installed but failed to run.");
        return build_entry(
            instance_id,
            settings,
            checked_at,
            fallback_models,
            vec![],
            vec![],
            probe,
        );
    }

    let models_timeout = probe_timeout(MODELS_PROBE_TIMEOUT, &merged);
    let mut cli_models = probe_models(binary, &env, context.server_cwd, models_timeout).await;
    // An expired token prints the logged-out line, then the CLI refreshes it; a second run
    // tells a refresh from a real logout.
    if cli_models.authenticated == Some(false) && !has_api_key {
        let recheck = probe_models(binary, &env, context.server_cwd, models_timeout).await;
        if recheck.authenticated.is_some() {
            cli_models = recheck;
        }
    }
    let auth = if has_api_key {
        json!({"status": "authenticated", "type": "api_key", "label": "xAI API key"})
    } else {
        match cli_models.authenticated {
            Some(true) => {
                json!({"status": "authenticated", "type": "cached_token", "label": "Grok account"})
            }
            Some(false) => json!({"status": "unauthenticated"}),
            None => unknown_auth(),
        }
    };

    // `discoverGrokSkills` gets the instance's merged environment, then adds the probe
    // variables itself.
    let skills = discover_skills(
        binary,
        &env,
        context.workspace_cwd.as_deref(),
        probe_timeout(SKILLS_PROBE_TIMEOUT, &merged),
    )
    .await
    .unwrap_or_default();

    let initialized = crate::initialize_probe(
        &crate::flavor::GROK,
        binary,
        &env,
        context.server_cwd,
        probe_timeout(ACP_INITIALIZE_TIMEOUT, &merged),
    )
    .await;
    let acp_failed = initialized.is_none();
    let acp_models = initialized
        .as_ref()
        .map(models_from_initialize)
        .unwrap_or_default();
    let discovered = if acp_models.is_empty() {
        cli_models.models
    } else {
        acp_models
    };
    let discovered_empty = discovered.is_empty();
    let models = if discovered_empty {
        fallback_models
    } else {
        models_from_settings(discovered, &settings.custom_models)
    };
    let incomplete = if acp_failed {
        Some("Grok CLI is installed but ACP initialize failed. Model options may be incomplete.")
    } else if discovered_empty {
        Some("Grok CLI did not list any models. Model options may be incomplete.")
    } else {
        None
    };

    if auth["status"] == "unauthenticated" {
        let probe = Probe {
            installed: true,
            version,
            status: "error",
            auth,
            message: Some("Grok CLI is installed but not logged in. Run `grok login`.".into()),
        };
        return build_entry(
            instance_id,
            settings,
            checked_at,
            models,
            vec![],
            skills,
            probe,
        );
    }
    let slash_commands = initialized
        .as_ref()
        .map_or_else(|| vec![compact_command()], slash_commands_from_initialize);
    let probe = Probe {
        installed: true,
        version,
        status: if incomplete.is_some() {
            "warning"
        } else {
            "ready"
        },
        auth,
        message: incomplete.map(str::to_owned),
    };
    build_entry(
        instance_id,
        settings,
        checked_at,
        models,
        slash_commands,
        skills,
        probe,
    )
}

/// `probeGrokModels`: only a clean exit is read.
async fn probe_models(
    binary: &str,
    env: &[(String, String)],
    cwd: &Path,
    timeout: Duration,
) -> CliModels {
    match spawn_and_collect(binary, &["models"], env, Some(cwd), timeout).await {
        Ok(Some(output)) if output.code == 0 => {
            parse_models_output(&format!("{}\n{}", output.stdout, output.stderr))
        }
        _ => CliModels::default(),
    }
}

/// `discoverGrokSkills`: `grok inspect --json` in the workspace; `None` on any failure.
async fn discover_skills(
    binary: &str,
    env: &[(String, String)],
    cwd: Option<&Path>,
    timeout: Duration,
) -> Option<Vec<Value>> {
    let output = spawn_and_collect(binary, &["inspect", "--json"], env, cwd, timeout)
        .await
        .ok()??;
    if output.code != 0 {
        return None;
    }
    decode_skills(&output.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOGGED_IN: &str = "You are logged in with grok.com.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n";

    #[test]
    fn reads_login_state_and_models() {
        let parsed = parse_models_output(LOGGED_IN);
        assert_eq!(parsed.authenticated, Some(true));
        let slugs: Vec<_> = parsed
            .models
            .iter()
            .map(|m| {
                (
                    m["slug"].as_str().unwrap().to_owned(),
                    m["isDefault"] == true,
                )
            })
            .collect();
        assert_eq!(
            slugs,
            vec![
                ("grok-4.6".to_owned(), true),
                ("grok-4.5".to_owned(), false)
            ]
        );
        assert_eq!(parsed.models[0]["name"], "Grok 4.6");
        let out = parse_models_output(&LOGGED_IN.replace(
            "You are logged in with grok.com.",
            "You are not authenticated.",
        ));
        assert_eq!(out.authenticated, Some(false));
    }

    #[test]
    fn slash_commands_drop_overrides_and_context() {
        let commands = slash_commands_from_initialize(
            &json!({"protocolVersion": 1, "_meta": {"availableCommands": [
                {"name": "compact", "description": "Compress history", "input": {"hint": "what to preserve"}},
                {"name": "always-approve", "description": "Skip", "input": {"hint": "on|off"}},
                {"name": "context", "description": "Show context usage", "input": null},
                {"name": "session-info", "description": "Show session details"},
                null,
                {"name": "broken", "description": 42},
                {"name": "deep-research", "description": "Research a topic", "input": {"hint": "<query>"}},
            ]}}),
        );
        let names: Vec<_> = commands
            .iter()
            .map(|c| c["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["compact", "session-info", "deep-research"]);
        assert_eq!(commands[0]["input"], json!({"hint": "what to preserve"}));
    }

    #[test]
    fn versions_parse_like_the_generic_parser() {
        let out = |s: &str, code| CommandOutput {
            stdout: s.into(),
            stderr: String::new(),
            code,
        };
        assert_eq!(
            parse_version(&out("grok 1.0.52\n", 0)).as_deref(),
            Some("1.0.52")
        );
        assert_eq!(parse_version(&out("v2.3.4", 0)).as_deref(), Some("2.3.4"));
        assert_eq!(parse_version(&out("x1.2.3", 0)), None);
        assert_eq!(parse_version(&out("1.2.3", 1)), None);
    }

    #[test]
    fn settings_follow_t3s_enabled_rule() {
        assert!(!GrokSettings::from_instance(None).enabled);
        assert!(!GrokSettings::from_instance(Some(&json!({"driver": "grok"}))).enabled);
        assert!(
            GrokSettings::from_instance(Some(&json!({"driver": "grok", "enabled": true}))).enabled
        );
        assert!(
            !GrokSettings::from_instance(Some(
                &json!({"driver": "grok", "enabled": true, "config": {"enabled": false}})
            ))
            .enabled
        );
        let s = GrokSettings::from_instance(Some(
            &json!({"driver": "grok", "config": {"enabled": true, "binaryPath": "  "}}),
        ));
        assert!(s.enabled);
        assert_eq!(s.binary_path, "grok");
    }

    #[test]
    fn the_disabled_entry_decodes_as_a_server_provider() {
        let entry = initial_entry("grok", &GrokSettings::default(), "2026-11-14T00:00:00.000Z");
        assert_eq!(entry["status"], "disabled");
        assert_eq!(entry["message"], "Grok is disabled in T3 Code settings.");
        let _: conn_contract::ServerProvidersItemItem = conn_contract::from_json(entry).unwrap();
    }

    #[test]
    fn reasoning_options_sort_low_to_high_and_mark_the_default() {
        let caps = model_capabilities(&json!({"modelId": "m", "name": "M", "_meta": {
            "reasoningEffort": "high",
            "reasoningEfforts": [
                {"value": "high", "label": "High", "default": true},
                {"value": "low", "label": "Low"},
            ],
        }}));
        let d = &caps["optionDescriptors"][0];
        assert_eq!(d["options"][0]["id"], "low");
        assert_eq!(d["options"][1]["isDefault"], true);
        assert_eq!(d["currentValue"], "high");
    }
}
