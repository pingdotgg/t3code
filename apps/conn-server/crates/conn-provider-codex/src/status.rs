//! Codex's `ServerProvider` entry, probed as the T3 server probes it
//! (`checkCodexProviderStatus` and `probeCodexAppServerProvider` in
//! `apps/server/src/provider/CodexProvider.ts`; `CodexDriver.ts` applies the model catalog,
//! `applyCodexModelCatalog`, and stamps the instance, `withInstanceIdentity`).
//!
//! The probe starts the instance's `codex app-server` (its binary, launch arguments, home and
//! environment, plus `MISE_OFFLINE=1`) in the server's working folder and asks, in order:
//! `initialize`, `account/read`, then together `skills/list`, `model/list` (every page; for a
//! ChatGPT account again after Codex refreshed its model cache) and `config/read` (3 s), and
//! `account/rateLimits/read` when the config routes to OpenAI itself. The whole probe has
//! 20 s (`T3CODE_CODEX_PROBE_TIMEOUT_MS` can only lengthen it); the optional reads end 250 ms
//! before that. The process ends after the probe: stdin closed, SIGTERM to its group, SIGKILL
//! after 2 s. A probe that fails runs `codex --version` (4 s) for the version.
//!
//! What the account read returns is the account's status (type, plan, email), never a token;
//! this module reads no credential file. It reads `$CODEX_HOME/models_cache.json` for its
//! `fetched_at` stamp only, as T3 does.
//!
//! Not ported, on purpose: the version advisory (a registry lookup), the managed setup mode
//! and shadow homes, and the watch on `auth.json` that probes again after `codex login`
//! (the next probe, on the interval or `server.refreshProviders`, shows it).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot};

use conn_provider_support::instance::{InstanceEnvelope, trimmed};
use conn_provider_support::lines::Line;
use conn_provider_support::probe::{CommandError, spawn_and_collect};
use conn_provider_support::process::{ExitInfo, LaunchSpec, ProcEvent, Process};

use crate::protocol::{self, Inbound};
use crate::{CodexConfig, DRIVER, launch};

/// `CODEX_AUTH_PROBE_TIMEOUT_MS`.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
/// `DEFAULT_TIMEOUT_MS`: the `--version` fallback.
const VERSION_TIMEOUT: Duration = Duration::from_secs(4);
/// `CODEX_CONFIG_PROBE_TIMEOUT_MS`.
const CONFIG_TIMEOUT: Duration = Duration::from_secs(3);
/// `CODEX_CATALOG_REFRESH_TIMEOUT_MS` and `CODEX_CATALOG_REFRESH_POLL`.
const CATALOG_REFRESH_TIMEOUT: Duration = Duration::from_secs(3);
const CATALOG_REFRESH_POLL: Duration = Duration::from_millis(100);
/// `CODEX_DISCOVERY_MARGIN_MS`.
const DISCOVERY_MARGIN: Duration = Duration::from_millis(250);
/// `CODEX_APP_SERVER_PROBE_FORCE_KILL_AFTER`.
const FORCE_KILL_AFTER: Duration = Duration::from_secs(2);
/// `MODEL_NEW_BADGE_DURATION_MS`.
const NEW_BADGE_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// Model list pages one probe follows; a CLI that keeps sending a cursor stops there.
const MAX_MODEL_PAGES: usize = 32;
const DISPLAY_NAME: &str = "Codex";
const CLIENT_NAME: &str = "T3 Code";
/// `PREFERRED_DEFAULT_CODEX_MODELS`.
const PREFERRED_DEFAULT_MODELS: [&str; 3] = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra"];
const DEFAULT_SERVICE_TIER: &str = "default";

/// The model catalog from T3's bundled manifest (`tools/gen-model-catalog.mjs`).
const MODEL_CATALOG: &str = include_str!("model_catalog.json");

/// What the probe reads from the instance's `providerInstances` entry beyond the launch
/// settings in [`CodexConfig`].
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StatusSettings {
    pub enabled: bool,
    pub display_name: Option<String>,
    pub accent_color: Option<String>,
    /// `customModels`, as stored.
    pub custom_models: Vec<Value>,
}

impl StatusSettings {
    /// From the `providerInstances[id]` envelope (`None`: the default instance, unconfigured).
    pub fn from_instance(entry: Option<&Value>) -> Self {
        let envelope = InstanceEnvelope::parse(entry, true);
        let custom_models = entry
            .and_then(|e| e.get("config"))
            .and_then(|c| c.get("customModels"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Self {
            enabled: envelope.enabled,
            display_name: envelope.display_name,
            accent_color: envelope.accent_color,
            custom_models,
        }
    }
}

/// One probe's inputs.
pub struct ProbeInput<'a> {
    pub instance_id: &'a str,
    pub config: &'a CodexConfig,
    pub settings: &'a StatusSettings,
    /// The server's environment (`process.env`, with the login shell's PATH).
    pub host_env: Vec<(String, String)>,
    /// The server's working folder (`process.cwd()`).
    pub cwd: PathBuf,
    pub checked_at: String,
}

/// Names the instance only: the environment holds secrets.
impl std::fmt::Debug for ProbeInput<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProbeInput")
            .field("instance_id", &self.instance_id)
            .field("cwd", &self.cwd)
            .finish_non_exhaustive()
    }
}

// ---- Environment ----

fn get<'a>(env: &'a [(String, String)], name: &str) -> Option<&'a str> {
    env.iter()
        .rev()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
}

fn set(env: &mut Vec<(String, String)>, name: &str, value: &str) {
    env.retain(|(k, _)| k != name);
    env.push((name.to_owned(), value.to_owned()));
}

/// `mergeProviderInstanceEnvironment`, then `providerProbeEnvironment`: the host
/// environment, the instance's entries over it, `MISE_OFFLINE=1`.
fn resolved_environment(config: &CodexConfig, host: &[(String, String)]) -> Vec<(String, String)> {
    let mut env = host.to_vec();
    for (name, value) in config.instance_env.iter() {
        set(&mut env, name, value);
    }
    set(&mut env, "MISE_OFFLINE", "1");
    env
}

/// `codexProcessEnvironment`: the originator unless the environment names one, the resolved
/// environment, and `CODEX_HOME` for a home path.
fn process_environment(
    config: &CodexConfig,
    resolved: &[(String, String)],
) -> Vec<(String, String)> {
    let mut env = resolved.to_vec();
    if get(&env, launch::ORIGINATOR_ENV).is_none() {
        env.push((launch::ORIGINATOR_ENV.to_owned(), CLIENT_NAME.to_owned()));
    }
    if let Some(home) = &config.home_path {
        set(&mut env, "CODEX_HOME", &home.to_string_lossy());
    }
    env
}

/// `resolveProviderProbeTimeoutMs("codex", …)`: an override only lengthens a timeout.
fn probe_timeout(default: Duration, environment: &[(String, String)]) -> Duration {
    let default_ms = u64::try_from(default.as_millis()).unwrap_or(u64::MAX);
    get(environment, "T3CODE_CODEX_PROBE_TIMEOUT_MS")
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|ms| *ms > default_ms && *ms <= 2_147_483_647)
        .map_or(default, Duration::from_millis)
}

/// `resolveHomePath` for the shared home: the home path, else `~/.codex`, absolute.
fn shared_home(config: &CodexConfig, host: &[(String, String)]) -> String {
    match &config.home_path {
        Some(home) => home.to_string_lossy().into_owned(),
        None => {
            let home = get(host, "HOME").unwrap_or("");
            Path::new(home)
                .join(".codex")
                .to_string_lossy()
                .into_owned()
        }
    }
}

// ---- The app-server client ----

/// Why the probe failed, with T3's texts (`effect-codex-app-server` errors).
#[derive(Clone, Debug, PartialEq)]
enum ProbeError {
    /// `CodexAppServerSpawnError`: the binary could not start.
    Spawn,
    /// `CodexAppServerRequestError`.
    Rpc { code: i64, message: String },
    /// `CodexAppServerProcessExitedError`.
    Exited {
        code: Option<i32>,
        stderr: Option<String>,
    },
}

impl ProbeError {
    fn message(&self, binary: &str) -> String {
        match self {
            Self::Spawn => {
                format!("Failed to spawn Codex App Server process for command: {binary} app-server")
            }
            Self::Rpc { message, .. } => message.clone(),
            Self::Exited { code, stderr } => {
                let base = match code {
                    Some(code) => format!("Codex App Server process exited with code {code}"),
                    None => "Codex App Server process exited".to_owned(),
                };
                match stderr {
                    Some(stderr) => format!("{base}: {stderr}"),
                    None => base,
                }
            }
        }
    }

    /// `codexRateLimitsFailureMessage`.
    fn usage_message(&self) -> String {
        match self {
            Self::Rpc { code, .. } => format!("Codex could not read usage (JSON-RPC {code})."),
            Self::Spawn => "Codex could not be started to read usage.".into(),
            Self::Exited { .. } => "Codex exited before it could report usage.".into(),
        }
    }
}

#[derive(Default)]
struct ClientState {
    next_id: u64,
    pending: Vec<(u64, oneshot::Sender<Result<Value, ProbeError>>)>,
    exited: Option<ProbeError>,
}

/// The probe's own app-server: one process, requests by id, no routing.
struct Client {
    process: Option<Process>,
    writer: mpsc::Sender<String>,
    state: Arc<Mutex<ClientState>>,
}

fn lock(state: &Mutex<ClientState>) -> std::sync::MutexGuard<'_, ClientState> {
    state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Client {
    fn spawn(spec: &LaunchSpec) -> Result<Self, ProbeError> {
        let (tx, mut rx) = mpsc::channel(64);
        let process = Process::spawn(spec, crate::client::MAX_LINE_BYTES, tx)
            .map_err(|_| ProbeError::Spawn)?;
        let writer = process.writer();
        let state = Arc::new(Mutex::new(ClientState::default()));
        let reader = Arc::clone(&state);
        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    ProcEvent::Line(Line::Text(text)) => {
                        if let Inbound::Response { id, result } = Inbound::decode(&text) {
                            let mut state = lock(&reader);
                            if let Some(at) = state.pending.iter().position(|(p, _)| *p == id) {
                                let (_, tx) = state.pending.swap_remove(at);
                                let _ = tx.send(result.map_err(|e| ProbeError::Rpc {
                                    code: e.code,
                                    message: e.message,
                                }));
                            }
                        }
                    }
                    ProcEvent::Line(Line::Oversized(_)) => {}
                    ProcEvent::Exited(info) => {
                        let error = exited(&info);
                        let mut state = lock(&reader);
                        for (_, tx) in state.pending.drain(..) {
                            let _ = tx.send(Err(error.clone()));
                        }
                        state.exited = Some(error);
                        return;
                    }
                }
            }
        });
        Ok(Self {
            process: Some(process),
            writer,
            state,
        })
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, ProbeError> {
        let rx = {
            let mut state = lock(&self.state);
            if let Some(error) = &state.exited {
                return Err(error.clone());
            }
            state.next_id += 1;
            let id = state.next_id;
            let (tx, rx) = oneshot::channel();
            state.pending.push((id, tx));
            let _ = self.writer.try_send(protocol::request(id, method, params));
            rx
        };
        match rx.await {
            Ok(result) => result,
            Err(_) => Err(lock(&self.state)
                .exited
                .clone()
                .unwrap_or(ProbeError::Exited {
                    code: None,
                    stderr: None,
                })),
        }
    }

    fn notify(&self, method: &str) {
        let _ = self.writer.try_send(protocol::notification(method));
    }

    /// The scope's end: stdin closed, SIGTERM to the group, SIGKILL after 2 s.
    async fn close(mut self) {
        if let Some(process) = self.process.take() {
            drop(self.writer);
            process.terminate(FORCE_KILL_AFTER).await;
        }
    }
}

fn exited(info: &ExitInfo) -> ProbeError {
    ProbeError::Exited {
        code: info.code,
        stderr: stderr_excerpt(&info.stderr_tail),
    }
}

// ---- stderr ----

/// `stripVTControlCharacters`: ANSI escape sequences (7-bit and C1).
fn strip_controls(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.peek() {
                Some('[') => {
                    chars.next();
                    skip_csi(&mut chars);
                }
                Some(']') => {
                    chars.next();
                    // OSC: until BEL or ESC \.
                    while let Some(c) = chars.next() {
                        if c == '\u{7}' {
                            break;
                        }
                        if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                Some(_) => {
                    chars.next();
                }
                None => {}
            },
            '\u{9b}' => skip_csi(&mut chars),
            other => out.push(other),
        }
    }
    out
}

fn skip_csi(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) {
    for c in chars.by_ref() {
        if ('\u{40}'..='\u{7e}').contains(&c) {
            break;
        }
    }
}

/// `ERROR_LINE_PATTERN`: `/^(?:[a-z]*error|fatal)(?: ?\[[^\]]+\])?:\s*\S/i`.
fn is_error_line(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    let letters = lower.bytes().take_while(u8::is_ascii_lowercase).count();
    // Every place the label can end: after a run of letters ending in "error", or "fatal".
    let mut ends: Vec<usize> = (5..=letters)
        .filter(|end| lower.get(..*end).is_some_and(|w| w.ends_with("error")))
        .collect();
    if lower.starts_with("fatal") {
        ends.push(5);
    }
    ends.into_iter().any(|end| {
        let rest = lower.get(end..).unwrap_or("");
        let candidates = [Some(rest), bracketed(rest)];
        candidates.into_iter().flatten().any(|rest| {
            rest.strip_prefix(':')
                .is_some_and(|after| after.trim_start().chars().next().is_some())
        })
    })
}

/// The text after an optional ` [code]` (`(?: ?\[[^\]]+\])`).
fn bracketed(rest: &str) -> Option<&str> {
    let inner = rest.strip_prefix(" [").or_else(|| rest.strip_prefix('['))?;
    let close = inner.find(']').filter(|close| *close > 0)?;
    inner.get(close + 1..)
}

/// `EXIT_SUMMARY_PATTERN`: `/\b(?:exit status|exit code|exited with code)\s+\d+\.?$/i`.
fn is_exit_summary(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    let body = lower.strip_suffix('.').unwrap_or(&lower);
    let digits = body.bytes().rev().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return false;
    }
    let Some(head) = body.get(..body.len() - digits) else {
        return false;
    };
    let trimmed = head.trim_end();
    if trimmed.len() == head.len() {
        return false;
    }
    ["exit status", "exit code", "exited with code"]
        .iter()
        .any(|phrase| {
            trimmed.strip_suffix(phrase).is_some_and(|before| {
                before
                    .chars()
                    .next_back()
                    .is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'))
            })
        })
}

/// `stderrExcerpt`: the line that says what failed, at most 512 characters.
fn stderr_excerpt(tail: &str) -> Option<String> {
    const MAX: usize = 512;
    let stripped = strip_controls(tail);
    let lines: Vec<String> = stripped
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|l| !l.is_empty())
        .collect();
    let last = lines.len().checked_sub(1)?;
    let error_index = lines.iter().rposition(|l| is_error_line(l));
    let index = match error_index {
        Some(i) if !lines.last().is_some_and(|l| is_exit_summary(l)) => i,
        _ => last,
    };
    let line = lines.get(index)?;
    let summary = is_exit_summary(line);
    let excerpt = if summary {
        lines
            .get(index.saturating_sub(2)..=index)
            .map(|l| l.join(" | "))?
    } else {
        line.clone()
    };
    let count = excerpt.chars().count();
    if count <= MAX {
        return Some(excerpt);
    }
    if summary && excerpt != *line {
        let tail: String = excerpt.chars().skip(count - (MAX - 1)).collect();
        Some(format!("…{tail}"))
    } else {
        let head: String = excerpt.chars().take(MAX - 1).collect();
        Some(format!("{head}…"))
    }
}

// ---- Models ----

/// `codexModelFamily`.
fn model_family(slug: &str) -> &str {
    if slug.starts_with("openai.gpt-") {
        slug.get("openai.".len()..).unwrap_or(slug)
    } else {
        slug
    }
}

/// `formatCodexModelName`.
fn format_model_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let rest = match name.get(..3) {
        Some(head) if head.eq_ignore_ascii_case("gpt") => {
            out.push_str("GPT");
            name.get(3..).unwrap_or("")
        }
        _ => name,
    };
    let mut chars = rest.chars().peekable();
    while let Some(c) = chars.next() {
        out.push(c);
        if c == '-'
            && let Some(next) = chars.peek().copied()
            && next.is_ascii_lowercase()
        {
            out.push(next.to_ascii_uppercase());
            chars.next();
        }
    }
    out
}

fn effort_label(effort: &str) -> &str {
    match effort {
        "none" => "None",
        "minimal" => "Minimal",
        "low" => "Low",
        "medium" => "Medium",
        "high" => "High",
        "xhigh" => "Extra High",
        "max" => "Max",
        "ultra" => "Ultra",
        other => other,
    }
}

fn cyber_label(program: &str) -> &str {
    match program {
        "standard" => "Standard",
        "daybreakBlue" => "Daybreak Blue",
        "daybreakRed" => "Daybreak Red",
        other => other,
    }
}

fn str_of(value: &Value) -> Option<&str> {
    value.as_str()
}

/// `mapCodexModelCapabilities`.
fn model_capabilities(model: &Value) -> Value {
    let slug = model["model"].as_str().unwrap_or("");
    let default_effort = if model_family(slug) == "gpt-6-astra" {
        Some("medium")
    } else {
        model["defaultReasoningEffort"].as_str()
    };
    let reasoning: Vec<Value> = model["supportedReasoningEfforts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|option| option["reasoningEffort"].as_str())
        .map(|effort| {
            let mut option = json!({"id": effort, "label": effort_label(effort)});
            if Some(effort) == default_effort {
                option["isDefault"] = json!(true);
            }
            option
        })
        .collect();
    let default_reasoning = reasoning
        .iter()
        .find(|o| o["isDefault"] == true)
        .and_then(|o| o["id"].as_str().map(str::to_owned));
    let tiers: Vec<(String, String, String)> =
        match model["serviceTiers"].as_array().filter(|t| !t.is_empty()) {
            Some(tiers) => tiers
                .iter()
                .map(|t| {
                    (
                        str_of(&t["id"]).unwrap_or("").to_owned(),
                        str_of(&t["name"]).unwrap_or("").to_owned(),
                        str_of(&t["description"]).unwrap_or("").to_owned(),
                    )
                })
                .collect(),
            None => model["additionalSpeedTiers"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(|id| {
                    let name = if id == "fast" { "Fast" } else { id };
                    (id.to_owned(), name.to_owned(), String::new())
                })
                .collect(),
        };
    let catalog_default = model["defaultServiceTier"]
        .as_str()
        .filter(|d| tiers.iter().any(|(id, _, _)| id == d));
    let default_tier = catalog_default.unwrap_or(DEFAULT_SERVICE_TIER).to_owned();
    let mut descriptors = Vec::new();
    if !reasoning.is_empty() {
        let mut descriptor = json!({"id": "reasoningEffort", "label": "Reasoning", "type": "select", "options": reasoning});
        if let Some(value) = default_reasoning {
            descriptor["currentValue"] = json!(value);
        }
        descriptors.push(descriptor);
    }
    if !tiers.is_empty() {
        let mut options = vec![{
            let mut standard = json!({"id": DEFAULT_SERVICE_TIER, "label": "Standard"});
            if default_tier == DEFAULT_SERVICE_TIER {
                standard["isDefault"] = json!(true);
            }
            standard
        }];
        for (id, name, description) in &tiers {
            let description = if id == "ultrafast" {
                "Even faster, more expensive"
            } else {
                description.as_str()
            };
            let mut option = json!({"id": id, "label": name});
            if !description.is_empty() {
                option["description"] = json!(description);
            }
            if default_tier == *id {
                option["isDefault"] = json!(true);
            }
            options.push(option);
        }
        descriptors.push(
            json!({"id": "serviceTier", "label": "Service Tier", "type": "select",
            "options": options, "currentValue": default_tier}),
        );
    }
    let cyber: Vec<&str> = model["availableAccessPrograms"]["cyber"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    if !cyber.is_empty() {
        let has_standard = cyber.contains(&"standard");
        let default_program = if has_standard {
            Some("standard")
        } else {
            cyber.first().copied()
        };
        let programs: Vec<&str> = if has_standard {
            cyber.clone()
        } else {
            std::iter::once("standard")
                .chain(cyber.iter().copied())
                .collect()
        };
        let options: Vec<Value> = programs
            .iter()
            .map(|program| {
                let mut option = json!({"id": program, "label": cyber_label(program)});
                if Some(*program) == default_program {
                    option["isDefault"] = json!(true);
                }
                option
            })
            .collect();
        let mut descriptor = json!({"id": "cyberAccessProgram", "label": "Cyber Access", "type": "select", "options": options});
        if let Some(program) = default_program {
            descriptor["currentValue"] = json!(program);
        }
        descriptors.push(descriptor);
    }
    json!({"optionDescriptors": descriptors})
}

/// `parseCodexModelListResponse`.
fn parse_models(response: &Value) -> Vec<Value> {
    response["data"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|model| {
            let mut entry = Map::new();
            entry.insert("slug".into(), model["model"].clone());
            entry.insert(
                "name".into(),
                json!(format_model_name(
                    model["displayName"].as_str().unwrap_or("")
                )),
            );
            entry.insert("isCustom".into(), json!(false));
            if model["isDefault"] == true {
                entry.insert("isDefault".into(), json!(true));
            }
            entry.insert("capabilities".into(), model_capabilities(model));
            Value::Object(entry)
        })
        .collect()
}

/// `readCustomModelEntries`: slug, name and capabilities, trimmed; the first of each slug.
fn custom_model_entries(custom: &[Value]) -> Vec<(String, String, Option<Value>)> {
    let mut entries: Vec<(String, String, Option<Value>)> = Vec::new();
    for raw in custom {
        let (slug, name, capabilities) = match raw {
            Value::String(s) => (Some(s.trim().to_owned()), None, None),
            Value::Object(o) => (
                o.get("slug").and_then(trimmed),
                o.get("name").and_then(trimmed),
                o.get("capabilities").filter(|c| c.is_object()).map(|c| {
                    json!({"optionDescriptors": c.get("optionDescriptors").filter(|d| d.is_array()).cloned().unwrap_or_else(|| json!([]))})
                }),
            ),
            _ => continue,
        };
        let Some(slug) = slug.filter(|s| !s.is_empty()) else {
            continue;
        };
        if entries.iter().any(|(s, _, _)| *s == slug) {
            continue;
        }
        let name = name.unwrap_or_else(|| slug.clone());
        entries.push((slug, name, capabilities));
    }
    entries
}

/// `appendCustomCodexModels` (`providerModelsFromSettings` with the first built-in
/// model's capabilities for a bare custom slug).
fn append_custom_models(models: Vec<Value>, custom: &[Value]) -> Vec<Value> {
    let entries = custom_model_entries(custom);
    if entries.is_empty() {
        return models;
    }
    let fallback = models
        .iter()
        .find(|m| !m["capabilities"].is_null())
        .map(|m| m["capabilities"].clone())
        .unwrap_or(Value::Null);
    let mut out: Vec<Value> = models
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
    for (slug, name, capabilities) in entries {
        if out.iter().any(|m| m["slug"] == slug.as_str()) {
            continue;
        }
        out.push(json!({
            "slug": slug,
            "name": name,
            "isCustom": true,
            "capabilities": capabilities.unwrap_or_else(|| fallback.clone()),
        }));
    }
    out
}

/// `applyPreferredCodexDefaultModel`.
fn apply_preferred_default(models: Vec<Value>) -> Vec<Value> {
    let preferred = PREFERRED_DEFAULT_MODELS.iter().find_map(|family| {
        models
            .iter()
            .find(|m| m["isCustom"] != true && m["slug"].as_str().map(model_family) == Some(family))
            .and_then(|m| m["slug"].as_str().map(str::to_owned))
    });
    let Some(preferred) = preferred else {
        return models;
    };
    models
        .into_iter()
        .map(|mut model| {
            if let Some(object) = model.as_object_mut() {
                if object.get("slug").and_then(Value::as_str) == Some(preferred.as_str()) {
                    object.insert("isDefault".into(), json!(true));
                } else {
                    object.remove("isDefault");
                }
            }
            model
        })
        .collect()
}

/// `mapCodexOptionDescriptors`: `update` for each model with option descriptors.
fn map_descriptors(
    models: Vec<Value>,
    update: impl Fn(&Value, &Value) -> Vec<Value>,
) -> Vec<Value> {
    models
        .into_iter()
        .map(|mut model| {
            let Some(descriptors) = model["capabilities"]["optionDescriptors"]
                .as_array()
                .cloned()
            else {
                return model;
            };
            let next: Vec<Value> = descriptors.iter().flat_map(|d| update(d, &model)).collect();
            model["capabilities"]["optionDescriptors"] = Value::Array(next);
            model
        })
        .collect()
}

/// `withConfiguredSelectDefault`.
fn with_select_default(
    models: Vec<Value>,
    id: &str,
    pick: impl Fn(&[Value]) -> Option<String>,
) -> Vec<Value> {
    map_descriptors(models, |descriptor, _| {
        if descriptor["id"] != id || descriptor["type"] != "select" {
            return vec![descriptor.clone()];
        }
        let options = descriptor["options"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let Some(value) = pick(&options) else {
            return vec![descriptor.clone()];
        };
        let mut next = descriptor.clone();
        next["currentValue"] = json!(value);
        next["options"] = Value::Array(
            options
                .into_iter()
                .map(|mut option| {
                    if let Some(object) = option.as_object_mut() {
                        object.remove("isDefault");
                        if object.get("id").and_then(Value::as_str) == Some(value.as_str()) {
                            object.insert("isDefault".into(), json!(true));
                        }
                    }
                    option
                })
                .collect(),
        );
        vec![next]
    })
}

/// `applyConfiguredCodexServiceTier`.
fn apply_service_tier(models: Vec<Value>, tier: Option<&str>) -> Vec<Value> {
    let Some(tier) = tier.filter(|t| !t.is_empty()) else {
        return models;
    };
    with_select_default(models, "serviceTier", |options| {
        options
            .iter()
            .find(|o| o["id"] == tier || (tier == "fast" && o["id"] == "priority"))
            .and_then(|o| o["id"].as_str().map(str::to_owned))
    })
}

/// `applyConfiguredCodexCyberAccess`.
fn apply_cyber_access(models: Vec<Value>, daybreak: Option<bool>, unavailable: bool) -> Vec<Value> {
    let offered = map_descriptors(models, |descriptor, model| {
        if descriptor["id"] != "cyberAccessProgram" || descriptor["type"] != "select" {
            return vec![descriptor.clone()];
        }
        if model["isCustom"] == true || unavailable {
            return vec![];
        }
        if daybreak.is_some() {
            return vec![descriptor.clone()];
        }
        let mut next = descriptor.clone();
        if let Some(object) = next.as_object_mut() {
            object.remove("currentValue");
        }
        if let Some(options) = next["options"].as_array_mut() {
            for option in options {
                if let Some(object) = option.as_object_mut() {
                    object.remove("isDefault");
                }
            }
        }
        vec![next]
    });
    if daybreak != Some(true) {
        return offered;
    }
    with_select_default(offered, "cyberAccessProgram", |options| {
        ["daybreakBlue", "daybreakRed"]
            .iter()
            .find(|program| options.iter().any(|o| o["id"] == **program))
            .map(|p| (*p).to_owned())
    })
}

// ---- Model catalog ----

/// `parseSemver`: (major, minor, patch, has a prerelease, prerelease parts).
fn parse_semver(value: &str) -> Option<(u64, u64, u64, Vec<String>)> {
    let without_build = value.trim().split('+').next().unwrap_or("");
    let (main, pre) = without_build.split_once('-').unwrap_or((without_build, ""));
    let mut segments: Vec<&str> = main
        .split('.')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    while !segments.is_empty() && segments.len() < 3 {
        segments.push("0");
    }
    let [major, minor, patch] = segments.as_slice() else {
        return None;
    };
    let number = |s: &str| -> Option<u64> {
        (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
            .then(|| s.parse().ok())
            .flatten()
    };
    let prerelease = pre
        .split('.')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    Some((
        number(major.trim_start_matches('v'))?,
        number(minor)?,
        number(patch)?,
        prerelease,
    ))
}

/// `compareSemverVersions` for two versions that parse.
fn compare_versions(left: &str, right: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let (Some(l), Some(r)) = (parse_semver(left), parse_semver(right)) else {
        return left.cmp(right);
    };
    let main = (l.0, l.1, l.2).cmp(&(r.0, r.1, r.2));
    if main != Ordering::Equal {
        return main;
    }
    match (l.3.is_empty(), r.3.is_empty()) {
        (true, true) => return Ordering::Equal,
        (true, false) => return Ordering::Greater,
        (false, true) => return Ordering::Less,
        _ => {}
    }
    for index in 0..l.3.len().max(r.3.len()) {
        let (Some(a), Some(b)) = (l.3.get(index), r.3.get(index)) else {
            return l.3.len().cmp(&r.3.len());
        };
        let order = match (a.parse::<u64>(), b.parse::<u64>()) {
            (Ok(x), Ok(y)) => x.cmp(&y),
            (Ok(_), Err(_)) => Ordering::Less,
            (Err(_), Ok(_)) => Ordering::Greater,
            (Err(_), Err(_)) => a.cmp(b),
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    Ordering::Equal
}

/// `resolveProviderCatalog` for the bundled manifest at `now_ms`.
fn catalog(now_ms: i64) -> Option<Value> {
    let mut catalog: Value = serde_json::from_str(MODEL_CATALOG).ok()?;
    for entry in catalog["models"].as_array_mut()? {
        let released = entry["releasedAt"]
            .as_str()
            .and_then(conn_support::time::millis_from_iso);
        let new = entry["status"] == "current"
            && released.is_some_and(|r| now_ms >= r && now_ms - r < NEW_BADGE_MS);
        if new {
            entry["badge"] = json!("new");
        }
    }
    Some(catalog)
}

/// `catalogEntry` lookup: the slug, else its family.
fn catalog_entry<'a>(catalog: &'a Value, slug: &str) -> Option<&'a Value> {
    let models = catalog["models"].as_array()?;
    models
        .iter()
        .find(|e| e["slug"] == slug)
        .or_else(|| models.iter().find(|e| e["slug"] == model_family(slug)))
}

/// `applyCodexModelCatalog`: legacy marks, the catalog's default, and the models that need
/// a newer CLI.
fn apply_catalog(entry: &mut Map<String, Value>, catalog: Option<&Value>) {
    entry.remove("updateRequiredModels");
    let mut models: Vec<Value> = entry
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    // `classifyCatalogModels`.
    for model in &mut models {
        if model["isCustom"] == true {
            continue;
        }
        let slug = model["slug"].as_str().unwrap_or("").to_owned();
        let legacy = catalog
            .and_then(|c| catalog_entry(c, &slug))
            .is_some_and(|e| e["status"] == "legacy");
        if let Some(object) = model.as_object_mut() {
            if legacy {
                object.insert("isLegacy".into(), json!(true));
            } else {
                object.remove("isLegacy");
            }
        }
    }
    // `applyCatalogDefault`.
    if let Some(requested) = catalog.and_then(|c| c["defaultChatModel"].as_str()) {
        let slug = models
            .iter()
            .find(|m| m["slug"] == requested)
            .or_else(|| {
                models.iter().find(|m| {
                    m["isCustom"] != true
                        && m["slug"].as_str().map(model_family) == Some(model_family(requested))
                })
            })
            .and_then(|m| m["slug"].as_str().map(str::to_owned));
        let previous = slug.as_ref().and_then(|slug| {
            models
                .iter()
                .find(|m| m["isDefault"] == true && m["slug"] != slug.as_str())
                .map(|m| {
                    (
                        m["slug"].clone(),
                        m["aliases"].as_array().cloned().unwrap_or_default(),
                    )
                })
        });
        if let (Some(slug), Some((previous, moved))) = (slug, previous) {
            for model in &mut models {
                let Some(object) = model.as_object_mut() else {
                    continue;
                };
                if object.get("slug") == Some(&previous) {
                    object.remove("isDefault");
                    object.remove("aliases");
                } else if object.get("slug").and_then(Value::as_str) == Some(slug.as_str()) {
                    let mut aliases: Vec<Value> = object
                        .get("aliases")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    for alias in &moved {
                        if !aliases.contains(alias) {
                            aliases.push(alias.clone());
                        }
                    }
                    object.insert("isDefault".into(), json!(true));
                    if !aliases.is_empty() {
                        object.insert("aliases".into(), Value::Array(aliases));
                    }
                }
            }
        }
    }
    // `codexUpdateRequiredModels`.
    let version = entry
        .get("version")
        .and_then(Value::as_str)
        .map(|v| v.strip_prefix('v').unwrap_or(v).to_owned());
    let mut required = Vec::new();
    if let (Some(catalog), Some(version)) = (catalog, version.filter(|v| parse_semver(v).is_some()))
    {
        for item in catalog["models"].as_array().into_iter().flatten() {
            let slug = item["slug"].as_str().unwrap_or("");
            let discovered = models
                .iter()
                .any(|m| m["slug"].as_str().map(model_family) == Some(model_family(slug)));
            if item["status"] != "current" || discovered {
                continue;
            }
            let Some(min) = item["minVersion"]
                .as_str()
                .filter(|m| parse_semver(m).is_some())
            else {
                continue;
            };
            if compare_versions(&version, min) != std::cmp::Ordering::Less {
                continue;
            }
            let mut model = json!({"slug": slug, "name": item["name"]});
            if let Some(badge) = item["badge"].as_str() {
                model["badge"] = json!(badge);
            }
            model["minVersion"] = json!(min);
            required.push(model);
        }
    }
    entry.insert("models".into(), Value::Array(models));
    if !required.is_empty() {
        entry.insert("updateRequiredModels".into(), Value::Array(required));
    }
}

// ---- Config reads ----

/// `CodexRoutingConfig` decoded: `None` when a field has the wrong type.
struct Routing {
    model_provider: Option<String>,
    openai_base_url: Option<String>,
    /// Provider id → its `base_url` (`None`: absent or null).
    providers: Vec<(String, Option<String>)>,
}

fn nullable_string(value: Option<&Value>) -> Result<Option<String>, ()> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(()),
    }
}

fn nullable_bool(value: Option<&Value>) -> Result<Option<bool>, ()> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(_) => Err(()),
    }
}

fn decode_routing(config: &Value) -> Option<Routing> {
    let object = config.as_object()?;
    let mut providers = Vec::new();
    match object.get("model_providers") {
        None => {}
        Some(Value::Object(map)) => {
            for (id, provider) in map {
                let provider = provider.as_object()?;
                providers.push((id.clone(), nullable_string(provider.get("base_url")).ok()?));
            }
        }
        Some(_) => return None,
    }
    Some(Routing {
        model_provider: nullable_string(object.get("model_provider")).ok()?,
        openai_base_url: nullable_string(object.get("openai_base_url")).ok()?,
        providers,
    })
}

/// `codexRouteBaseUrl`: `Ok(None)` is Codex's OpenAI default; `Err` a route that cannot be read.
fn route_base_url(config: &Value) -> Result<Option<String>, ()> {
    let routing = decode_routing(config).ok_or(())?;
    let provider = routing.model_provider.unwrap_or_else(|| "openai".into());
    if provider == "openai" {
        return Ok(routing.openai_base_url.filter(|u| !u.is_empty()));
    }
    match routing
        .providers
        .into_iter()
        .find(|(id, _)| *id == provider)
    {
        Some((_, base)) => Ok(base),
        None => Err(()),
    }
}

/// An http(s) URL's scheme, host and origin (`URL` in the WHATWG sense, for what these reads
/// need). `None` for anything else.
fn http_origin(url: &str) -> Option<(String, String, String)> {
    let (scheme, rest) = url.trim().split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let (host, port) = if let Some(stripped) = host_port.strip_prefix('[') {
        let (host, after) = stripped.split_once(']')?;
        (
            format!("[{}]", host.to_ascii_lowercase()),
            after.strip_prefix(':').map(str::to_owned),
        )
    } else {
        match host_port.rsplit_once(':') {
            Some((h, p)) => (h.to_ascii_lowercase(), Some(p.to_owned())),
            None => (host_port.to_ascii_lowercase(), None),
        }
    };
    if host.is_empty() {
        return None;
    }
    let default_port = if scheme == "https" { "443" } else { "80" };
    let port = port.filter(|p| !p.is_empty());
    if let Some(p) = &port
        && (!p.bytes().all(|b| b.is_ascii_digit()) || p.parse::<u32>().map_or(true, |n| n > 65_535))
    {
        return None;
    }
    let port = port
        .map(|p| p.trim_start_matches('0').to_owned())
        .map(|p| if p.is_empty() { "0".into() } else { p });
    let origin = match port.filter(|p| p != default_port) {
        Some(port) => format!("{scheme}://{host}:{port}"),
        None => format!("{scheme}://{host}"),
    };
    Some((scheme, host, origin))
}

/// `routesToNativeOpenai`.
fn routes_to_native_openai(config: &Value) -> bool {
    match route_base_url(config) {
        Err(()) => false,
        Ok(None) => true,
        Ok(Some(url)) => http_origin(&url).is_some_and(|(scheme, host, _)| {
            scheme == "https" && (host == "api.openai.com" || host == "chatgpt.com")
        }),
    }
}

/// `codexCustomEndpoint`.
fn custom_endpoint(config: &Value) -> Option<String> {
    let url = route_base_url(config).ok().flatten()?;
    let (_, _, origin) = http_origin(&url)?;
    (!routes_to_native_openai(config)).then_some(origin)
}

/// `CodexCyberAccessConfig` decoded: (`daybreak`, `features.api_key_cyber_access_programs`).
fn decode_cyber_access(config: &Value) -> Option<(Option<bool>, Option<bool>)> {
    let object = config.as_object()?;
    let daybreak = nullable_bool(object.get("daybreak")).ok()?;
    let programs = match object.get("features") {
        None | Some(Value::Null) => None,
        Some(Value::Object(features)) => {
            nullable_bool(features.get("api_key_cyber_access_programs")).ok()?
        }
        Some(_) => return None,
    };
    Some((daybreak, programs))
}

// ---- Account and usage ----

/// `codexPlanLabel`.
pub fn plan_label(plan: Option<&str>) -> Option<&'static str> {
    Some(match plan? {
        "free" => "ChatGPT Free Subscription",
        "go" => "ChatGPT Go Subscription",
        "plus" => "ChatGPT Plus Subscription",
        "pro" => "ChatGPT Pro 200 Subscription",
        "prolite" => "ChatGPT Pro 100 Subscription",
        "promax" => "ChatGPT Pro 500 Subscription",
        "self_serve_business_prolite" => "ChatGPT Business Premium Subscription",
        "team" | "self_serve_business_usage_based" | "business" => "ChatGPT Business Subscription",
        "ent26" | "enterprise_cbp_automation" | "enterprise_cbp_usage_based" | "enterprise" => {
            "ChatGPT Enterprise Subscription"
        }
        "edu" | "edu_plus" | "edu_pro" => "ChatGPT Edu Subscription",
        "unknown" => "ChatGPT Subscription",
        _ => return None,
    })
}

/// The rate limit read: an answer, or why there is none.
enum RateLimits {
    Read(Value),
    Failed(String),
}

/// `isoFromEpochSeconds`.
fn iso_from_seconds(value: &Value) -> Option<String> {
    let seconds = value.as_f64().filter(|s| s.is_finite() && *s > 0.0)?;
    let millis = seconds * 1000.0;
    // `DateTime.make` refuses a time past JavaScript's range.
    (millis <= 8.64e15).then(|| conn_support::time::iso_from_millis(millis as i64))
}

fn clamp_percent(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 100.0)
    } else {
        0.0
    }
}

fn percent(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9.0e15 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

/// `codexRateLimitsToWindows`.
fn rate_limit_windows(snapshot: &Value) -> Vec<Value> {
    const SESSION: i64 = 5 * 60;
    const WEEK: i64 = 7 * 24 * 60;
    const MONTH: i64 = 30 * 24 * 60;
    if snapshot["limitId"]
        .as_str()
        .is_some_and(|id| !id.is_empty() && id != "codex")
    {
        return vec![];
    }
    let monthly_plan = matches!(snapshot["planType"].as_str(), Some("free" | "go"));
    let positions = [
        (
            "primary",
            &snapshot["primary"],
            if monthly_plan { MONTH } else { SESSION },
        ),
        ("secondary", &snapshot["secondary"], WEEK),
    ];
    let mut windows = Vec::new();
    for (id, window, fallback) in positions {
        let Some(used) = window["usedPercent"].as_f64().filter(|u| u.is_finite()) else {
            continue;
        };
        let duration = window["windowDurationMins"]
            .as_f64()
            .unwrap_or(fallback as f64);
        let kind = if duration >= MONTH as f64 {
            "monthly"
        } else if duration >= WEEK as f64 {
            "weekly"
        } else {
            "session"
        };
        let label = match kind {
            "session" => "Session",
            "weekly" => "Weekly",
            _ => "Monthly",
        };
        let mut entry = json!({"id": id, "kind": kind, "label": label, "usedPercent": percent(clamp_percent(used)),
            "windowDurationMins": percent(duration)});
        if let Some(resets) = iso_from_seconds(&window["resetsAt"]) {
            entry["resetsAt"] = json!(resets);
        }
        windows.push(entry);
    }
    let individual = &snapshot["individualLimit"];
    if let Some(remaining) = individual["remainingPercent"]
        .as_f64()
        .filter(|r| r.is_finite())
    {
        let mut entry = json!({"id": "individual", "kind": "monthly", "label": "Monthly credit limit",
            "usedPercent": percent(clamp_percent(100.0 - remaining))});
        if let Some(resets) = iso_from_seconds(&individual["resetsAt"]) {
            entry["resetsAt"] = json!(resets);
        }
        windows.push(entry);
    }
    windows
}

/// `codexRateLimitsToLimits`, with `makeUsageLimits`'s window order.
fn usage_limits(response: &Value, checked_at: &str) -> Value {
    let snapshot = match &response["rateLimitsByLimitId"]["codex"] {
        Value::Object(_) => &response["rateLimitsByLimitId"]["codex"],
        _ => &response["rateLimits"],
    };
    let mut windows = rate_limit_windows(snapshot);
    let rank = |kind: &Value| match kind.as_str() {
        Some("session") => 0,
        Some("weekly") => 1,
        Some("monthly") => 2,
        _ => 3,
    };
    windows.sort_by(|a, b| {
        rank(&a["kind"]).cmp(&rank(&b["kind"])).then_with(|| {
            a["id"]
                .as_str()
                .unwrap_or("")
                .cmp(b["id"].as_str().unwrap_or(""))
        })
    });
    let mut limits = json!({"checkedAt": checked_at, "windows": windows});
    let credits = &response["rateLimitResetCredits"];
    if let Some(count) = credits["availableCount"].as_f64() {
        let next = credits["credits"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|c| c["status"] == "available")
            .filter_map(|c| c["expiresAt"].as_f64())
            .reduce(f64::min)
            .and_then(|min| iso_from_seconds(&json!(min)));
        let mut reset = json!({"availableCount": percent(count.max(0.0))});
        if let Some(next) = next {
            reset["nextExpiresAt"] = json!(next);
        }
        limits["resetCredits"] = reset;
    }
    limits
}

fn unavailable_usage(checked_at: &str, reason: &str, message: Option<&str>) -> Value {
    let mut unavailable = json!({"reason": reason});
    if let Some(message) = message.filter(|m| !m.is_empty()) {
        unavailable["message"] = json!(message);
    }
    json!({"checkedAt": checked_at, "windows": [], "unavailable": unavailable})
}

// ---- The probe ----

/// `CodexAppServerProviderSnapshot`.
struct Snapshot {
    account: Value,
    endpoint: Option<String>,
    native_usage: bool,
    rate_limits: Option<RateLimits>,
    version: Option<String>,
    /// `None`: Codex did not list its models in time.
    models: Option<Vec<Value>>,
    service_tier: Option<String>,
    daybreak: Option<bool>,
    cyber_unavailable: bool,
    skills: Vec<Value>,
}

/// `withCodexDiscoveryDeadline`: `None` once the deadline (or `cap`) passed.
async fn by_deadline<T>(
    deadline: tokio::time::Instant,
    cap: Option<Duration>,
    work: impl std::future::Future<Output = T>,
) -> Option<T> {
    let mut until = deadline;
    if let Some(cap) = cap {
        until = until.min(tokio::time::Instant::now() + cap);
    }
    if until <= tokio::time::Instant::now() {
        return None;
    }
    tokio::time::timeout_at(until, work).await.ok()
}

/// `requestAllCodexModels`.
async fn all_models(client: &Client) -> Result<Vec<Value>, ProbeError> {
    let mut models = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_MODEL_PAGES {
        let params = match &cursor {
            Some(cursor) => json!({"cursor": cursor}),
            None => json!({}),
        };
        let response = client.request("model/list", params).await?;
        models.extend(parse_models(&response));
        cursor = response["nextCursor"]
            .as_str()
            .filter(|c| !c.is_empty())
            .map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    Ok(models)
}

/// `readCodexModelsCacheFetchedAt`: the cache's `fetched_at`, or `None`.
async fn cache_fetched_at(codex_home: PathBuf) -> Option<i64> {
    tokio::task::spawn_blocking(move || {
        let text = std::fs::read_to_string(codex_home.join("models_cache.json")).ok()?;
        let value: Value = serde_json::from_str(&text).ok()?;
        conn_support::time::millis_from_iso(value["fetched_at"].as_str()?)
    })
    .await
    .ok()
    .flatten()
}

/// `requestCodexChatGptModels`: list, wait for Codex's own catalog refresh (a write to the
/// shared cache after this process started), list again.
async fn chatgpt_models(
    client: &Client,
    codex_home: Option<PathBuf>,
    spawned_ms: i64,
    deadline: tokio::time::Instant,
) -> Result<Option<Vec<Value>>, ProbeError> {
    let Some(models) = by_deadline(deadline, None, all_models(client))
        .await
        .transpose()?
    else {
        return Ok(None);
    };
    let poll = async {
        loop {
            if let Some(home) = &codex_home
                && cache_fetched_at(home.clone())
                    .await
                    .is_some_and(|at| at >= spawned_ms)
            {
                return;
            }
            tokio::time::sleep(CATALOG_REFRESH_POLL).await;
        }
    };
    if by_deadline(deadline, Some(CATALOG_REFRESH_TIMEOUT), poll)
        .await
        .is_none()
    {
        eprintln!(
            "conn-provider-codex: Codex did not refresh its model catalog in time; using the cached catalog."
        );
        return Ok(Some(models));
    }
    match by_deadline(deadline, None, all_models(client)).await {
        Some(again) => Ok(Some(again?)),
        None => Ok(Some(models)),
    }
}

/// `probeCodexAppServerProvider`.
async fn probe_app_server(
    client: &Client,
    cwd: &Path,
    probe_timeout: Duration,
    started: tokio::time::Instant,
    spawned_ms: i64,
) -> Result<Snapshot, ProbeError> {
    let init = client
        .request(
            "initialize",
            json!({"clientInfo": {"name": CLIENT_NAME, "title": CLIENT_NAME, "version": launch::CLIENT_VERSION},
                "capabilities": {"experimentalApi": true}}),
        )
        .await?;
    client.notify("initialized");
    // `initialize.userAgent.match(/\/([^\s]+)/)`.
    let version = init["userAgent"].as_str().and_then(|ua| {
        let (_, rest) = ua.split_once('/')?;
        let version: String = rest.chars().take_while(|c| !c.is_whitespace()).collect();
        (!version.is_empty()).then_some(version)
    });
    let account = client.request("account/read", json!({})).await?;
    let signed_in = account["account"].is_object();
    if !signed_in && account["requiresOpenaiAuth"] == true {
        return Ok(Snapshot {
            account,
            endpoint: None,
            native_usage: false,
            rate_limits: None,
            version,
            models: Some(vec![]),
            service_tier: None,
            daybreak: None,
            cyber_unavailable: false,
            skills: vec![],
        });
    }
    let deadline = (started + probe_timeout)
        .checked_sub(DISCOVERY_MARGIN)
        .unwrap_or(started);
    let cwd_text = cwd.to_string_lossy().into_owned();
    let skills = by_deadline(
        deadline,
        None,
        client.request("skills/list", json!({"cwds": [cwd_text]})),
    );
    let chatgpt = account["account"]["type"] == "chatgpt";
    let codex_home = init["codexHome"].as_str().map(PathBuf::from);
    let models = async {
        if chatgpt {
            chatgpt_models(client, codex_home, spawned_ms, deadline).await
        } else {
            by_deadline(deadline, None, all_models(client))
                .await
                .transpose()
        }
    };
    let config_and_usage = async {
        let config = by_deadline(
            deadline,
            Some(CONFIG_TIMEOUT),
            client.request("config/read", json!({"includeLayers": false})),
        )
        .await
        .and_then(Result::ok)
        .map(|r| r["config"].clone());
        let native_usage = config.as_ref().is_some_and(|config| {
            account["requiresOpenaiAuth"] == true
                && account["account"]["type"] != "apiKey"
                && routes_to_native_openai(config)
        });
        let rate_limits = if native_usage {
            Some(
                match by_deadline(
                    deadline,
                    None,
                    client.request("account/rateLimits/read", Value::Null),
                )
                .await
                {
                    None => RateLimits::Failed("Codex did not answer the usage request.".into()),
                    Some(Ok(response)) => RateLimits::Read(response),
                    Some(Err(e)) => RateLimits::Failed(e.usage_message()),
                },
            )
        } else {
            None
        };
        (config, native_usage, rate_limits)
    };
    // `Effect.all`: the first failure ends the others.
    let (skills, models, (config, native_usage, rate_limits)) = tokio::try_join!(
        // In T3's order every time: a failed read ends the others before they send more.
        biased;
        async { skills.await.transpose() },
        models,
        async { Ok::<_, ProbeError>(config_and_usage.await) },
    )?;
    let cyber = config.as_ref().and_then(decode_cyber_access);
    let api_key = account["account"]["type"] == "apiKey";
    Ok(Snapshot {
        endpoint: config.as_ref().and_then(custom_endpoint),
        native_usage,
        rate_limits,
        version,
        models,
        service_tier: config
            .as_ref()
            .and_then(|c| c["service_tier"].as_str().map(str::to_owned)),
        daybreak: config
            .as_ref()
            .map(|_| cyber.is_some_and(|(d, _)| d == Some(true))),
        cyber_unavailable: api_key
            && (config.is_none() || cyber.is_some_and(|(_, p)| p == Some(false))),
        skills: skills
            .map(|s| parse_skills(&s, &cwd_text))
            .unwrap_or_default(),
        account,
    })
}

/// `parseCodexSkillsListResponse`.
fn parse_skills(response: &Value, cwd: &str) -> Vec<Value> {
    let data = response["data"].as_array().cloned().unwrap_or_default();
    let skills: Vec<Value> = match data.iter().find(|e| e["cwd"] == cwd) {
        Some(entry) => entry["skills"].as_array().cloned().unwrap_or_default(),
        None => data
            .iter()
            .flat_map(|e| e["skills"].as_array().cloned().unwrap_or_default())
            .collect(),
    };
    skills
        .iter()
        .map(|skill| {
            let mut out =
                json!({"name": skill["name"], "path": skill["path"], "enabled": skill["enabled"]});
            let truthy = |v: &Value| v.as_str().filter(|s| !s.is_empty()).map(str::to_owned);
            if let Some(d) = truthy(&skill["description"]) {
                out["description"] = json!(d);
            }
            if let Some(s) = truthy(&skill["scope"]) {
                out["scope"] = json!(s);
            }
            if let Some(n) = truthy(&skill["interface"]["displayName"]) {
                out["displayName"] = json!(n);
            }
            let short = if skill["shortDescription"].is_string() {
                &skill["shortDescription"]
            } else {
                &skill["interface"]["shortDescription"]
            };
            if let Some(s) = truthy(short) {
                out["shortDescription"] = json!(s);
            }
            out
        })
        .collect()
}

/// `CODEX_CLI_VERSION_PATTERN` on `codex --version`'s stdout.
fn parse_cli_version(stdout: &str) -> Option<String> {
    stdout.split_whitespace().find_map(|token| {
        let token = token.strip_prefix('v').unwrap_or(token);
        let (main, pre) = token
            .split_once('-')
            .map_or((token, None), |(m, p)| (m, Some(p)));
        let parts: Vec<&str> = main.split('.').collect();
        let numeric = parts.len() == 3
            && parts
                .iter()
                .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
        let pre_ok = pre.is_none_or(|p| {
            !p.is_empty()
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        });
        (numeric && pre_ok).then(|| token.to_owned())
    })
}

/// `probeCodexCliVersion`.
async fn cli_version(
    binary: &str,
    env: &[(String, String)],
    cwd: &Path,
    timeout: Duration,
) -> Option<String> {
    match spawn_and_collect(binary, &["--version"], env, Some(cwd), timeout).await {
        Ok(Some(output)) if output.code == 0 => parse_cli_version(&output.stdout),
        Ok(_) | Err(CommandError::NotFound | CommandError::Failed(_)) => None,
    }
}

// ---- The entry ----

/// `ProviderProbeResult`.
struct Probe {
    installed: bool,
    version: Option<String>,
    status: &'static str,
    auth: Value,
    message: Option<String>,
    usage_limits: Option<Value>,
}

/// `buildServerProvider` with `CODEX_PRESENTATION`, then `applyCodexModelCatalog` and
/// `withInstanceIdentity`.
fn build_entry(
    input: &EntryInput<'_>,
    models: Vec<Value>,
    slash_commands: Vec<Value>,
    skills: Vec<Value>,
    probe: Probe,
) -> Value {
    let enabled = input.settings.enabled;
    let mut entry = Map::new();
    entry.insert("displayName".into(), json!(DISPLAY_NAME));
    entry.insert("showInteractionModeToggle".into(), json!(true));
    entry.insert("reportsContextWindow".into(), json!(true));
    entry.insert("enabled".into(), json!(enabled));
    entry.insert("installed".into(), json!(probe.installed));
    entry.insert("version".into(), json!(probe.version));
    entry.insert(
        "status".into(),
        json!(if enabled { probe.status } else { "disabled" }),
    );
    entry.insert("auth".into(), probe.auth);
    entry.insert(
        "setup".into(),
        json!({"canAuthenticate": false, "canInstall": false}),
    );
    entry.insert("checkedAt".into(), json!(input.checked_at));
    if let Some(message) = probe.message {
        entry.insert("message".into(), json!(message));
    }
    entry.insert("models".into(), Value::Array(models));
    entry.insert("slashCommands".into(), Value::Array(slash_commands));
    entry.insert("skills".into(), Value::Array(skills));
    if let Some(usage) = probe.usage_limits {
        entry.insert("usageLimits".into(), usage);
    }
    let now = conn_support::time::millis_from_iso(input.checked_at).unwrap_or(0);
    apply_catalog(&mut entry, catalog(now).as_ref());
    entry.insert("instanceId".into(), json!(input.instance_id));
    entry.insert("driver".into(), json!(DRIVER));
    if let Some(name) = &input.settings.display_name {
        entry.insert("displayName".into(), json!(name));
    }
    if let Some(color) = &input.settings.accent_color {
        entry.insert("accentColor".into(), json!(color));
    }
    entry.insert(
        "continuation".into(),
        json!({"groupKey": format!("codex:home:{}", input.shared_home)}),
    );
    Value::Object(entry)
}

struct EntryInput<'a> {
    instance_id: &'a str,
    settings: &'a StatusSettings,
    checked_at: &'a str,
    shared_home: String,
}

fn unknown_auth() -> Value {
    json!({"status": "unknown"})
}

fn disabled_probe() -> Probe {
    Probe {
        installed: false,
        version: None,
        status: "warning",
        auth: unknown_auth(),
        message: Some("Codex is disabled in Conn settings.".into()),
        usage_limits: None,
    }
}

/// `makePendingCodexProvider`: the entry until the first probe ends.
pub fn pending_entry(
    instance_id: &str,
    config: &CodexConfig,
    settings: &StatusSettings,
    host_env: &[(String, String)],
    checked_at: &str,
) -> Value {
    let input = EntryInput {
        instance_id,
        settings,
        checked_at,
        shared_home: shared_home(config, host_env),
    };
    let probe = if settings.enabled {
        Probe {
            installed: false,
            version: None,
            status: "warning",
            auth: unknown_auth(),
            message: Some("Codex provider status has not been checked in this session yet.".into()),
            usage_limits: None,
        }
    } else {
        disabled_probe()
    };
    build_entry(
        &input,
        append_custom_models(vec![], &settings.custom_models),
        vec![],
        vec![],
        probe,
    )
}

fn slash_commands() -> Vec<Value> {
    vec![
        json!({"name": "compact", "description": "Summarize the conversation and reduce context usage"}),
        json!({"name": "goal", "description": "Set a goal Codex keeps working toward until it is done",
            "input": {"hint": "Objective, or pause, resume, clear"}}),
        json!({"name": "feedback", "description": "Send this thread and Codex logs to OpenAI",
            "input": {"hint": "Describe the issue (optional)"}}),
    ]
}

/// `accountProbeStatus`: (status, auth, message).
fn account_status(
    snapshot: &Snapshot,
    codex_home: Option<&str>,
) -> (&'static str, Value, Option<String>) {
    let account = &snapshot.account["account"];
    let usage_plan = match &snapshot.rate_limits {
        Some(RateLimits::Read(response)) => response["rateLimits"]["planType"].as_str(),
        _ => None,
    };
    let label = match account["type"].as_str() {
        Some("apiKey") => Some("OpenAI API Key"),
        Some("amazonBedrock") => Some("Amazon Bedrock"),
        Some("chatgpt") => {
            let usage = if usage_plan == Some("unknown") {
                None
            } else {
                plan_label(usage_plan)
            };
            usage.or_else(|| plan_label(account["planType"].as_str()))
        }
        _ => None,
    };
    let email = (account["type"] == "chatgpt")
        .then(|| account["email"].as_str())
        .flatten()
        .filter(|e| !e.is_empty());
    let workspace = match &snapshot.rate_limits {
        Some(RateLimits::Read(response)) => response["accountId"]
            .as_str()
            .map(str::trim)
            .filter(|w| !w.is_empty()),
        _ => None,
    };
    let mut auth = json!({"status": if account.is_object() { "authenticated" } else { "unknown" }});
    if let Some(kind) = account["type"].as_str().filter(|k| !k.is_empty()) {
        auth["type"] = json!(kind);
    }
    if let Some(label) = label {
        auth["label"] = json!(label);
    }
    if let Some(email) = email {
        auth["email"] = json!(email);
    }
    if let Some(workspace) = workspace {
        auth["workspaceId"] = json!(workspace);
    }
    if account.is_object() {
        return ("ready", auth, None);
    }
    if snapshot.account["requiresOpenaiAuth"] == true {
        let message = match codex_home {
            Some(home) => format!(
                "Codex CLI is not authenticated. Run `codex login` with CODEX_HOME set to {} and try again.",
                Value::String(home.to_owned())
            ),
            None => "Codex CLI is not authenticated. Run `codex login` and try again.".to_owned(),
        };
        return ("error", json!({"status": "unauthenticated"}), Some(message));
    }
    ("ready", auth, None)
}

/// `checkCodexProviderStatus` for one instance, as `CodexDriver` runs it.
pub async fn check(input: ProbeInput<'_>) -> Value {
    let config = input.config;
    let entry_input = EntryInput {
        instance_id: input.instance_id,
        settings: input.settings,
        checked_at: &input.checked_at,
        shared_home: shared_home(config, &input.host_env),
    };
    let custom_only = || append_custom_models(vec![], &input.settings.custom_models);
    if !input.settings.enabled {
        return build_entry(
            &entry_input,
            custom_only(),
            vec![],
            vec![],
            disabled_probe(),
        );
    }
    let resolved = resolved_environment(config, &input.host_env);
    let timeout = probe_timeout(PROBE_TIMEOUT, &resolved);
    let binary = config.binary.to_string_lossy().into_owned();
    // The launch: the session's argv (`codexAppServerArgs`) and environment, plus
    // `MISE_OFFLINE=1`, in the server's working folder.
    let mut spec = launch::launch_spec(
        config,
        config.launch_args_env().as_deref(),
        get(&input.host_env, launch::ORIGINATOR_ENV).is_some(),
    );
    spec.cwd = Some(input.cwd.to_string_lossy().into_owned());
    spec.env_set.push(("MISE_OFFLINE".into(), "1".into()));
    if let Some(home) = &config.home_path {
        spec.env_set.retain(|(k, _)| k != "CODEX_HOME");
        spec.env_set
            .push(("CODEX_HOME".into(), home.to_string_lossy().into_owned()));
    }
    let started = tokio::time::Instant::now();
    let spawned_ms = i64::try_from(conn_support::time::now_ms()).unwrap_or(i64::MAX);
    let outcome = match Client::spawn(&spec) {
        Err(error) => Some(Err(error)),
        Ok(client) => {
            let result = tokio::time::timeout(
                timeout,
                probe_app_server(&client, &input.cwd, timeout, started, spawned_ms),
            )
            .await
            .ok();
            client.close().await;
            result
        }
    };
    let failed = |message: String, installed: bool, version: Option<String>| Probe {
        installed,
        version,
        status: "error",
        auth: unknown_auth(),
        message: Some(message),
        usage_limits: None,
    };
    let snapshot = match outcome {
        None => {
            let probe = Probe {
                installed: true,
                version: None,
                status: "error",
                auth: unknown_auth(),
                message: Some("Timed out while checking Codex app-server provider status.".into()),
                usage_limits: None,
            };
            return build_entry(&entry_input, custom_only(), vec![], vec![], probe);
        }
        Some(Err(ProbeError::Spawn)) => {
            let hint = if binary == "codex" {
                " Installing ChatGPT or Codex desktop may not add codex to PATH."
            } else {
                " Make sure the configured executable exists and can be run."
            };
            let message = format!(
                "Could not start Codex CLI (`{binary}`). Check Settings → Providers → Codex → Binary path on the server.{hint}"
            );
            return build_entry(
                &entry_input,
                custom_only(),
                vec![],
                vec![],
                failed(message, false, None),
            );
        }
        Some(Err(error)) => {
            let env = process_environment(config, &resolved);
            let version_timeout = probe_timeout(VERSION_TIMEOUT, &resolved);
            let version = cli_version(&binary, &env, &input.cwd, version_timeout).await;
            let message = format!(
                "Codex app-server provider probe failed: {}.",
                error.message(&binary)
            );
            return build_entry(
                &entry_input,
                custom_only(),
                vec![],
                vec![],
                failed(message, true, version),
            );
        }
        Some(Ok(snapshot)) => snapshot,
    };
    let home = config
        .home_path
        .as_ref()
        .map(|h| h.to_string_lossy().into_owned());
    let (status, auth, message) = account_status(&snapshot, home.as_deref());
    let usage = if !snapshot.native_usage && message.is_none() {
        unavailable_usage(&input.checked_at, "unsupported", None)
    } else {
        match &snapshot.rate_limits {
            Some(RateLimits::Read(response)) => usage_limits(response, &input.checked_at),
            Some(RateLimits::Failed(failure)) => {
                unavailable_usage(&input.checked_at, "probeFailed", Some(failure))
            }
            None => unavailable_usage(&input.checked_at, "probeFailed", message.as_deref()),
        }
    };
    let models_missing = snapshot.models.is_none();
    let models = append_custom_models(
        snapshot.models.clone().unwrap_or_default(),
        &input.settings.custom_models,
    );
    let models = apply_preferred_default(models);
    let models = apply_service_tier(models, snapshot.service_tier.as_deref());
    let models = apply_cyber_access(models, snapshot.daybreak, snapshot.cyber_unavailable);
    let mut auth = auth;
    if let Some(endpoint) = &snapshot.endpoint {
        auth["endpoint"] = json!(endpoint);
    }
    let message = message.or_else(|| {
        models_missing.then(|| "Codex did not return its model catalog in time.".to_owned())
    });
    let probe = Probe {
        installed: true,
        version: snapshot.version.clone(),
        status: if models_missing { "warning" } else { status },
        auth,
        message,
        usage_limits: Some(usage),
    };
    build_entry(
        &entry_input,
        models,
        slash_commands(),
        snapshot.skills.clone(),
        probe,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// T3's own cases for `stderrExcerpt` (`effect-codex-app-server` `_internal/stdio.test.ts`).
    #[test]
    fn stderr_excerpts_match_t3() {
        let cases: [(&str, &str, String); 13] = [
            (
                "node launcher",
                [
                    "file:///usr/local/lib/node_modules/@openai/codex/bin/codex.js:107",
                    "  throw new Error(",
                    "        ^",
                    "",
                    "Error: Missing optional dependency @openai/codex-darwin-arm64. Reinstall Codex: npm install -g @openai/codex@latest",
                    "    at findCodexExecutable (file:///usr/local/lib/node_modules/@openai/codex/bin/codex.js:107:9)",
                    "",
                    "Node.js v26.8.2",
                    "",
                ]
                .join("\n")
                .leak(),
                "Error: Missing optional dependency @openai/codex-darwin-arm64. Reinstall Codex: npm install -g @openai/codex@latest".into(),
            ),
            (
                "node error code",
                "node:internal/modules/esm/resolve:873\n  throw new ERR_MODULE_NOT_FOUND(\n\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'x'\n    at packageResolve (node:internal/modules/esm/resolve:873:9)\n",
                "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'x'".into(),
            ),
            (
                "rust cli",
                "error: unexpected argument 'app-server' found\n\nUsage: codex [OPTIONS]\n",
                "error: unexpected argument 'app-server' found".into(),
            ),
            ("upper", "ERROR: Missing dependency\nUsage: codex [OPTIONS]\n", "ERROR: Missing dependency".into()),
            (
                "unlabelled",
                "WARNING: proceeding without PATH aliases\nMissing OpenAI API key.\n",
                "Missing OpenAI API key.".into(),
            ),
            (
                "dns",
                "Starting provider\nпроверить токен LLM: Get \"https://llm-gateway.example/api/models\": dial tcp: lookup llm-gateway.example: no such host\nне удалось отправить метрики на сервер: no such host\nОшибка: ошибка запуска плагина: exit status 1",
                "проверить токен LLM: Get \"https://llm-gateway.example/api/models\": dial tcp: lookup llm-gateway.example: no such host | не удалось отправить метрики на сервер: no such host | Ошибка: ошибка запуска плагина: exit status 1".into(),
            ),
            (
                "auth",
                "oauth2: \"invalid_request\" \"Errors.OIDCSession.RefreshTokenInvalid\"\nError: provider launcher exited with code 1.",
                "oauth2: \"invalid_request\" \"Errors.OIDCSession.RefreshTokenInvalid\" | Error: provider launcher exited with code 1.".into(),
            ),
            (
                "summary first",
                "Error: starting provider\nlookup failed: no such host\nОшибка: exit status 1",
                "Error: starting provider | lookup failed: no such host | Ошибка: exit status 1".into(),
            ),
            ("summary alone", "Error: command failed with exit code 1\n", "Error: command failed with exit code 1".into()),
            (
                "bounded",
                format!("{}\noauth2: invalid_request\nError: launcher exited with code 1\n", "x".repeat(1000)).leak(),
                {
                    let full = format!("{} | oauth2: invalid_request | Error: launcher exited with code 1", "x".repeat(1000));
                    let tail: String = full.chars().skip(full.chars().count() - 511).collect();
                    format!("…{tail}")
                },
            ),
            (
                "ansi",
                "\u{1b}[31m  Error:\t  config.toml   is invalid \u{1b}[0m\r\n",
                "Error: config.toml is invalid".into(),
            ),
            ("c1", "\u{9b}31mError: invalid config\u{9b}0m\nUsage: codex [OPTIONS]\n", "Error: invalid config".into()),
            (
                "oversized",
                format!("Error: {}", "x".repeat(1000)).leak(),
                format!("Error: {}…", "x".repeat(504)),
            ),
        ];
        for (name, stderr, excerpt) in cases {
            assert_eq!(
                stderr_excerpt(stderr).as_deref(),
                Some(excerpt.as_str()),
                "{name}"
            );
            assert!(excerpt.chars().count() <= 512, "{name}");
        }
        assert_eq!(stderr_excerpt("\n \t\r\n\u{1b}[0m\n"), None);
    }

    #[test]
    fn model_names_and_versions() {
        assert_eq!(format_model_name("gpt-6-luna"), "GPT-6-Luna");
        assert_eq!(format_model_name("GPT-6.1 Sol"), "GPT-6.1 Sol");
        assert_eq!(format_model_name("o3-mini"), "o3-Mini");
        assert_eq!(
            parse_cli_version("codex-cli 0.166.0\n").as_deref(),
            Some("0.166.0")
        );
        assert_eq!(
            parse_cli_version("codex-cli 0.160.0-alpha.1").as_deref(),
            Some("0.160.0-alpha.1")
        );
        assert_eq!(
            parse_cli_version("0.1.4161006").as_deref(),
            Some("0.1.4161006")
        );
        assert_eq!(parse_cli_version("codex v1.2.3").as_deref(), Some("1.2.3"));
        assert_eq!(parse_cli_version("codex 1.2"), None);
    }

    #[test]
    fn routes_and_endpoints() {
        assert!(routes_to_native_openai(&json!({})));
        assert!(routes_to_native_openai(
            &json!({"openai_base_url": "HTTPS://API.OPENAI.COM/v1"})
        ));
        assert!(!routes_to_native_openai(
            &json!({"openai_base_url": "http://api.openai.com/v1"})
        ));
        let router = json!({"model_provider": "orbit", "model_providers": {"orbit": {"base_url": "http://router.orbit:8080/v1"}}});
        assert!(!routes_to_native_openai(&router));
        assert_eq!(
            custom_endpoint(&router).as_deref(),
            Some("http://router.orbit:8080")
        );
        assert_eq!(custom_endpoint(&json!({"model_provider": "x"})), None);
        assert_eq!(
            custom_endpoint(&json!({"openai_base_url": "https://gw.example:443/v1"})).as_deref(),
            Some("https://gw.example")
        );
        assert!(!routes_to_native_openai(&json!({"model_provider": 3})));
    }

    #[test]
    fn the_catalog_marks_legacy_and_missing_models() {
        let mut entry = Map::new();
        entry.insert("version".into(), json!("0.154.0"));
        entry.insert(
            "models".into(),
            json!([{"slug": "gpt-6-sol", "name": "x", "isCustom": false, "capabilities": null},
                   {"slug": "gpt-6-astra", "name": "y", "isCustom": false, "capabilities": null}]),
        );
        apply_catalog(&mut entry, catalog(0).as_ref());
        assert_eq!(entry["models"][0]["isLegacy"], true);
        assert!(entry["models"][1].get("isLegacy").is_none());
        let required: Vec<&str> = entry["updateRequiredModels"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|m| m["slug"].as_str())
            .collect();
        assert_eq!(required, ["gpt-6-luna"]);
    }
}
