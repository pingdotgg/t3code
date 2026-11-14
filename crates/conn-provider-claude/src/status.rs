//! Claude's `ServerProvider` entry, probed as the T3 server probes it
//! (`checkClaudeProviderStatus` and `probeClaudeCapabilities` in
//! `apps/server/src/provider/ClaudeProvider.ts`, `buildServerProvider` and
//! `withInstanceIdentity` from `provider-core`).
//!
//! The probe runs `claude --version` (20 s), filters T3's bundled catalog by that version
//! (`resolveClaudeModelsForVersion`), then runs the capabilities probe in the SDK host
//! (`probeCapabilities`, 25 s): the official SDK starts the CLI with a prompt that never
//! yields, so the CLI initializes and no request reaches the API. The host hands back the
//! account status the SDK reports (email, subscription, token source; never a token), the
//! slash commands and models, the usage windows and each settings source's effort caps.
//!
//! Not ported, on purpose: reset credits (`readClaudeResetCredits` calls Anthropic's API) and
//! the organization id (`readClaudeOrganizationId` reads Claude's account file), the version
//! advisory (a registry lookup), skills discovery, custom models, and the effort caps of
//! Claude's settings (`capClaudeCatalogEffort`: the host reads them, the entry does not
//! apply them yet).

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{Map, Value, json};

use conn_provider_support::instance::{InstanceEnv, InstanceEnvelope};
use conn_provider_support::probe::{CommandError, CommandOutput, spawn_and_collect};

use crate::DRIVER;

/// `CLAUDE_VERSION_CHECK_TIMEOUT_MS`.
const VERSION_TIMEOUT: Duration = Duration::from_secs(20);
/// `CAPABILITIES_PROBE_TIMEOUT_MS`.
const CAPABILITIES_TIMEOUT: Duration = Duration::from_secs(25);
/// Room for the host's own start beside the probe's deadline.
const HOST_CALL_SLACK: Duration = Duration::from_secs(15);
const DISPLAY_NAME: &str = "Claude";
const EFFORT_LEVELS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// `ClaudeSettings` as the instance's `providerInstances` entry gives it.
#[derive(Clone, Debug, PartialEq)]
pub struct StatusSettings {
    pub enabled: bool,
    /// `binaryPath`, `~` expanded; `claude` when empty.
    pub binary_path: String,
    /// `homePath`, trimmed; empty keeps the inherited `CLAUDE_CONFIG_DIR`.
    pub home_path: String,
    pub display_name: Option<String>,
    pub accent_color: Option<String>,
    /// The instance's `environment` entries with a value, in order. `Debug` prints names only.
    pub environment: InstanceEnv,
}

impl Default for StatusSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            binary_path: "claude".into(),
            home_path: String::new(),
            display_name: None,
            accent_color: None,
            environment: InstanceEnv::default(),
        }
    }
}

impl StatusSettings {
    /// From the `providerInstances[id]` envelope (`None`: the default instance, unconfigured).
    /// An explicit `false` on the envelope or in the config wins; Claude is on by default.
    pub fn from_instance(entry: Option<&Value>) -> Self {
        let Some(entry) = entry else {
            return Self::default();
        };
        let envelope = InstanceEnvelope::parse(Some(entry), true);
        Self {
            enabled: envelope.enabled,
            binary_path: envelope.config_str("binaryPath").map_or_else(
                || "claude".into(),
                |p| conn_provider_support::instance::expand_home(&p),
            ),
            home_path: envelope.config_str("homePath").unwrap_or_default(),
            display_name: envelope.display_name,
            accent_color: envelope.accent_color,
            environment: envelope.environment,
        }
    }

    /// `resolveClaudeHomePath`.
    fn resolved_home(&self, environment: &[(String, String)]) -> PathBuf {
        if !self.home_path.is_empty() {
            return crate::launch::expand_home(&self.home_path);
        }
        match get(environment, "CLAUDE_CONFIG_DIR").map(str::trim) {
            Some(dir) if !dir.is_empty() => PathBuf::from(dir),
            _ => crate::launch::expand_home("~/.claude"),
        }
    }
}

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

/// `mergeClaudeProcessEnvironment`, then `makeClaudeEnvironment`: the host environment with
/// T3's changes, the instance's entries, the settings entrypoint, and `CLAUDE_CONFIG_DIR` for
/// a `homePath`.
fn process_environment(
    settings: &StatusSettings,
    host: Vec<(String, String)>,
    settings_entrypoint: Option<String>,
) -> Vec<(String, String)> {
    let config = crate::ClaudeConfig {
        home_path: (!settings.home_path.is_empty())
            .then(|| crate::launch::expand_home(&settings.home_path)),
        instance_env: settings.environment.clone(),
        ..crate::ClaudeConfig::default()
    };
    let mut env = crate::launch::query_env(&config, "", false, host, settings_entrypoint);
    env.remove(crate::launch::AGENT_THREAD_ENV);
    env.into_iter()
        .filter_map(|(k, v)| Some((k, v.as_str()?.to_owned())))
        .collect()
}

/// `providerProbeEnvironment`.
fn probe_environment(env: &[(String, String)]) -> Vec<(String, String)> {
    let mut env = env.to_vec();
    set(&mut env, "MISE_OFFLINE", "1");
    env
}

/// `resolveProviderProbeTimeoutMs("claude", …)`: an override only lengthens a timeout.
fn probe_timeout(default: Duration, environment: &[(String, String)]) -> Duration {
    let default_ms = u64::try_from(default.as_millis()).unwrap_or(u64::MAX);
    get(environment, "T3CODE_CLAUDE_PROBE_TIMEOUT_MS")
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|ms| *ms > default_ms && *ms <= 2_147_483_647)
        .map_or(default, Duration::from_millis)
}

// ---- Versions ----

/// `parseSemver` → (major, minor, patch, prerelease).
fn parse_semver(value: &str) -> Option<(u64, u64, u64, Vec<String>)> {
    let without_build = value.trim().split('+').next().unwrap_or("");
    let (main, pre) = match without_build.split_once('-') {
        Some((main, pre)) => (main, pre),
        None => (without_build, ""),
    };
    let mut segments: Vec<&str> = main
        .split('.')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    while !segments.is_empty() && segments.len() < 3 {
        segments.push("0");
    }
    let first = segments.first().map(|s| s.trim_start_matches('v'));
    let [_, minor, patch] = segments.as_slice() else {
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
    Some((number(first?)?, number(minor)?, number(patch)?, prerelease))
}

/// `compareSemverVersions`.
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
            return if l.3.len() < r.3.len() {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        };
        let numeric = |s: &str| s.bytes().all(|c| c.is_ascii_digit());
        let order = match (numeric(a), numeric(b)) {
            (true, true) => a
                .parse::<u64>()
                .unwrap_or(0)
                .cmp(&b.parse::<u64>().unwrap_or(0)),
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            (false, false) => a.cmp(b),
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    Ordering::Equal
}

/// `parseCliVersionResult` with `parseGenericCliVersion`: the first `x.y.z` (after an
/// optional `v`) in stdout and stderr, only for a run that exited 0.
fn parse_version(result: &CommandOutput) -> Option<String> {
    if result.code != 0 {
        return None;
    }
    let text = format!("{}\n{}", result.stdout, result.stderr);
    let bytes = text.as_bytes();
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut start = 0;
    while start < bytes.len() {
        let at_boundary = start == 0 || bytes.get(start - 1).is_none_or(|b| !word(*b));
        let digits_at = if bytes.get(start) == Some(&b'v') {
            start + 1
        } else {
            start
        };
        if at_boundary && bytes.get(digits_at).is_some_and(u8::is_ascii_digit) {
            let mut end = digits_at;
            let mut dots = 0;
            let mut last_digit = false;
            while let Some(b) = bytes.get(end) {
                if b.is_ascii_digit() {
                    last_digit = true;
                } else if *b == b'.' && last_digit && dots < 2 {
                    dots += 1;
                    last_digit = false;
                } else {
                    break;
                }
                end += 1;
            }
            if dots == 2 && last_digit && bytes.get(end).is_none_or(|b| !word(*b)) {
                return text.get(digits_at..end).map(str::to_owned);
            }
        }
        start += 1;
    }
    None
}

/// The catalog's models with their Claude Code bounds.
struct CatalogModel {
    model: Value,
    min_version: Option<String>,
    max_version_exclusive: Option<String>,
}

fn catalog_models() -> Vec<CatalogModel> {
    let catalog = crate::catalog::catalog_json();
    let models = catalog["providerModels"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let bounds = catalog["compatibility"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    models
        .into_iter()
        .map(|model| {
            let bound = bounds.iter().find(|b| b["slug"] == model["slug"]);
            let field = |key: &str| bound.and_then(|b| b[key].as_str()).map(str::to_owned);
            CatalogModel {
                min_version: field("minVersion"),
                max_version_exclusive: field("maxVersionExclusive"),
                model,
            }
        })
        .collect()
}

/// `isVersionSupported`.
fn supported(model: &CatalogModel, version: Option<&str>) -> bool {
    if model.min_version.is_none() && model.max_version_exclusive.is_none() {
        return true;
    }
    let Some(version) = version else {
        return false;
    };
    if let Some(min) = &model.min_version
        && compare_versions(version, min).is_lt()
    {
        return false;
    }
    !model
        .max_version_exclusive
        .as_ref()
        .is_some_and(|max| compare_versions(version, max).is_ge())
}

/// `resolveUpdateRequiredModels`.
fn update_required(models: &[CatalogModel], version: Option<&str>) -> Vec<Value> {
    let Some(version) = version else {
        return Vec::new();
    };
    models
        .iter()
        .filter_map(|entry| {
            let min = entry.min_version.as_ref()?;
            if entry.model["isLegacy"] == true || compare_versions(version, min).is_ge() {
                return None;
            }
            let mut out = json!({"slug": entry.model["slug"], "name": entry.model["name"]});
            if let Some(badge) = entry.model.get("badge").filter(|b| b.is_string()) {
                out["badge"] = badge.clone();
            }
            out["minVersion"] = json!(min);
            Some(out)
        })
        .collect()
}

/// `formatClaudeVersionUpgradeMessage`.
fn upgrade_message(models: &[CatalogModel], version: Option<&str>) -> Option<String> {
    let mut unavailable: Vec<&CatalogModel> = models
        .iter()
        .filter(|entry| {
            entry
                .min_version
                .as_ref()
                .is_some_and(|min| version.is_none_or(|v| compare_versions(v, min).is_lt()))
        })
        .collect();
    unavailable.sort_by(|a, b| {
        compare_versions(
            a.min_version.as_deref().unwrap_or(""),
            b.min_version.as_deref().unwrap_or(""),
        )
    });
    let first = unavailable.first()?;
    let min = first.min_version.as_ref()?;
    let label = version.map_or_else(|| "the installed version".to_owned(), |v| format!("v{v}"));
    let name = first.model["name"].as_str().unwrap_or("");
    Some(format!(
        "Claude Code {label} is too old for {name}. Upgrade to v{min} or newer to access it."
    ))
}

// ---- Capabilities ----

/// What the host's `probeCapabilities` returned (`ClaudeCapabilitiesProbe`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Capabilities {
    pub email: Option<String>,
    pub subscription_type: Option<String>,
    pub token_source: Option<String>,
    pub api_key_source: Option<String>,
    pub api_provider: Option<String>,
    pub slash_commands: Vec<Value>,
    pub models: Vec<Value>,
    pub usage: Option<Value>,
    pub usage_checked_at: Option<String>,
    pub effort_caps: Vec<EffortCap>,
}

/// `ClaudeEffortCapSource`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct EffortCap {
    pub max: Option<String>,
    pub per_model: Vec<(String, String)>,
}

fn non_empty(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// `dedupeSlashCommands`: one per name, case-insensitive; a later one fills what is missing.
fn dedupe_commands(commands: Vec<Value>) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for command in commands {
        let Some(name) = non_empty(&command["name"]) else {
            continue;
        };
        let key = name.to_lowercase();
        match out
            .iter_mut()
            .find(|c| c["name"].as_str().map(str::to_lowercase).as_deref() == Some(&key))
        {
            None => {
                let mut command = command;
                command["name"] = json!(name);
                out.push(command);
            }
            Some(existing) => {
                if existing.get("description").is_none()
                    && let Some(d) = command.get("description").filter(|d| d.is_string())
                {
                    existing["description"] = d.clone();
                }
                if existing.pointer("/input/hint").is_none()
                    && let Some(h) = command.pointer("/input/hint").filter(|h| h.is_string())
                {
                    existing["input"] = json!({"hint": h});
                }
            }
        }
    }
    out
}

/// `parseClaudeInitializationCommands`.
fn init_commands(commands: &Value) -> Vec<Value> {
    let parsed = commands
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|command| {
            let name = non_empty(&command["name"])?;
            let mut out = json!({"name": name});
            if let Some(description) = non_empty(&command["description"]) {
                out["description"] = json!(description);
            }
            if let Some(hint) = non_empty(&command["argumentHint"]) {
                out["input"] = json!({"hint": hint});
            }
            Some(out)
        })
        .collect();
    dedupe_commands(parsed)
}

fn effort_cap(settings: &Value) -> Option<EffortCap> {
    let level = |v: &Value| {
        v.as_str()
            .filter(|l| EFFORT_LEVELS.contains(l))
            .map(str::to_owned)
    };
    let max = level(&settings["maxEffortLevel"]);
    let per_model: Vec<(String, String)> = settings["modelSettings"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(model, entry)| Some((model.clone(), level(&entry["maxEffortLevel"])?)))
        .collect();
    (max.is_some() || !per_model.is_empty()).then_some(EffortCap { max, per_model })
}

impl Capabilities {
    /// Reads the host's answer; only the listed account fields are kept.
    pub fn from_host(value: &Value) -> Self {
        let account = &value["account"];
        let field = |k: &str| account[k].as_str().map(str::to_owned);
        let settings = &value["settings"];
        let effort_caps = match settings.get("sources").and_then(Value::as_array) {
            Some(sources) => sources
                .iter()
                .filter_map(|s| effort_cap(&s["settings"]))
                .collect(),
            None => effort_cap(&settings["effective"]).into_iter().collect(),
        };
        Self {
            email: field("email"),
            subscription_type: field("subscriptionType"),
            token_source: field("tokenSource"),
            api_key_source: field("apiKeySource"),
            api_provider: field("apiProvider"),
            slash_commands: init_commands(&value["commands"]),
            models: value["models"].as_array().cloned().unwrap_or_default(),
            usage: value.get("usage").filter(|u| u.is_object()).cloned(),
            usage_checked_at: value["usageCheckedAt"].as_str().map(str::to_owned),
            effort_caps,
        }
    }

    /// `claudeAuthStatus`: only `tokenSource: "none"` with nothing else disproves auth.
    fn authenticated(&self) -> bool {
        if self
            .api_provider
            .as_deref()
            .is_some_and(|p| p != "firstParty")
        {
            return true;
        }
        if self.token_source.as_deref() != Some("none") {
            return true;
        }
        let api_key = self
            .api_key_source
            .as_deref()
            .is_some_and(|s| !s.is_empty() && s != "none");
        api_key
            || self.email.as_deref().is_some_and(|e| !e.is_empty())
            || self
                .subscription_type
                .as_deref()
                .is_some_and(|s| !s.is_empty())
    }
}

fn title_case(value: &str) -> String {
    value
        .split(|c: char| c.is_whitespace() || c == '_' || c == '-')
        .filter(|p| !p.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            chars.next().map_or_else(String::new, |first| {
                let mut word: String = first.to_uppercase().collect();
                word.push_str(&chars.as_str().to_lowercase());
                word
            })
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn squash(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|c| !(c.is_whitespace() || *c == '_' || *c == '-'))
        .collect()
}

/// `claudeSubscriptionLabel`.
fn subscription_label(subscription: &str) -> Option<String> {
    let normalized = squash(subscription);
    if normalized.is_empty() {
        return None;
    }
    Some(
        match normalized.as_str() {
            "claudemaxsubscription" | "claudemax5xsubscription" | "max" | "maxplan" | "max5" => {
                "Max"
            }
            "claudemax20xsubscription" | "max20" => "Ultra",
            "claudeenterprisesubscription" | "enterprise" => "Enterprise",
            "claudeteamsubscription" | "team" => "Team",
            "claudeprosubscription" | "pro" => "Pro",
            "claudefreesubscription" | "free" => "Free",
            _ => return Some(title_case(subscription)),
        }
        .to_owned(),
    )
}

/// `claudeAuthMetadata` and `apiProviderAuthMetadata`.
fn auth_metadata(capabilities: &Capabilities) -> Option<(String, String)> {
    if capabilities.api_provider.as_deref() == Some("bedrock") {
        return Some(("bedrock".into(), "Amazon Bedrock".into()));
    }
    let method = capabilities.token_source.as_deref().map(squash);
    if matches!(
        method.as_deref(),
        Some("apikey" | "anthropicapikey" | "anthropicauthtoken")
    ) {
        return Some(("apiKey".into(), "Claude API Key".into()));
    }
    let subscription = capabilities
        .subscription_type
        .as_deref()
        .filter(|s| !s.is_empty())?;
    let label = subscription_label(subscription).unwrap_or_else(|| title_case(subscription));
    let normalized = squash(&label);
    let label = match (
        normalized.starts_with("claude"),
        normalized.ends_with("subscription"),
    ) {
        (true, true) => label,
        (true, false) => format!("{label} Subscription"),
        (false, true) => format!("Claude {label}"),
        (false, false) => format!("Claude {label} Subscription"),
    };
    Some((subscription.to_owned(), label))
}

// ---- Usage limits (`claudeUsageResponseToLimits`) ----

fn clamp_percent(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 100.0)
    } else {
        0.0
    }
}

/// An ISO date as T3's `DateTime.formatIso` writes it, or `None` when it does not parse.
fn iso(value: &Value) -> Option<String> {
    let text = value.as_str().filter(|s| !s.is_empty())?;
    let ms = conn_support::time::millis_from_iso(text)?;
    Some(conn_support::time::iso_from_millis(ms))
}

fn window(
    id: &str,
    kind: &str,
    label: &str,
    mins: u64,
    used: f64,
    resets: Option<String>,
) -> Value {
    let mut window = json!({
        "id": id, "kind": kind, "label": label, "windowDurationMins": mins,
        "usedPercent": clamp_percent(used),
    });
    if let Some(resets) = resets {
        window["resetsAt"] = json!(resets);
    }
    window
}

fn percent_of(used: &Value, limit: &Value) -> Option<f64> {
    let (used, limit) = (used.as_f64()?, limit.as_f64()?);
    if !used.is_finite() || !limit.is_finite() || used < 0.0 || limit <= 0.0 {
        return None;
    }
    let percent = used / limit * 100.0;
    percent.is_finite().then(|| clamp_percent(percent))
}

fn spend_percent(limits: &Value) -> Option<f64> {
    let spend = &limits["spend"];
    let money = |m: &Value| {
        m["amount_minor"].as_u64().is_some()
            && m["currency"].as_str().is_some_and(|c| !c.is_empty())
            && m["exponent"].as_u64().is_some()
    };
    if spend["enabled"] == true
        && money(&spend["used"])
        && money(&spend["limit"])
        && spend["used"]["currency"].as_str().map(str::trim)
            == spend["limit"]["currency"].as_str().map(str::trim)
        && spend["used"]["exponent"] == spend["limit"]["exponent"]
        && let Some(percent) = percent_of(
            &spend["used"]["amount_minor"],
            &spend["limit"]["amount_minor"],
        )
    {
        return Some(percent);
    }
    let extra = &limits["extra_usage"];
    if extra["is_enabled"] != true {
        return None;
    }
    let percent = percent_of(&extra["used_credits"], &extra["monthly_limit"])
        .or_else(|| extra["utilization"].as_f64())?;
    (percent.is_finite() && percent >= 0.0).then(|| clamp_percent(percent))
}

fn usage_limits(usage: Option<&Value>, checked_at: &str) -> Value {
    let unavailable = |reason: &str| json!({"checkedAt": checked_at, "windows": [], "unavailable": {"reason": reason}});
    let Some(usage) = usage else {
        return unavailable("probeFailed");
    };
    let available = usage["rate_limits_available"] == true;
    let limits = &usage["rate_limits"];
    if !available || !limits.is_object() {
        return unavailable(if available {
            "probeFailed"
        } else {
            "unsupported"
        });
    }
    let mut windows = Vec::new();
    for (id, kind, label, mins) in [
        ("five_hour", "session", "Session", 300),
        ("seven_day", "weekly", "Weekly", 7 * 24 * 60),
    ] {
        if let Some(used) = limits[id]["utilization"].as_f64() {
            windows.push(window(
                id,
                kind,
                label,
                mins,
                used,
                iso(&limits[id]["resets_at"]),
            ));
        }
    }
    for entry in limits["model_scoped"].as_array().into_iter().flatten() {
        let (Some(name), Some(used)) = (
            entry["display_name"].as_str(),
            entry["utilization"].as_f64(),
        ) else {
            continue;
        };
        let token: String = name
            .to_lowercase()
            .split(|c: char| !c.is_ascii_alphanumeric())
            .collect::<Vec<_>>()
            .join("_");
        windows.push(window(
            &format!("seven_day_{token}"),
            "weekly",
            &format!("Weekly · {name}"),
            7 * 24 * 60,
            used,
            iso(&entry["resets_at"]),
        ));
    }
    if let Some(percent) = spend_percent(limits) {
        windows.push(json!({"id": "monthly_spend", "kind": "monthly",
            "label": "Monthly spend", "usedPercent": percent}));
    }
    let rank = |w: &Value| match w["kind"].as_str() {
        Some("session") => 0,
        Some("weekly") => 1,
        Some("monthly") => 2,
        _ => 3,
    };
    windows.sort_by(|a, b| {
        rank(a)
            .cmp(&rank(b))
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
    });
    let mut out = json!({"checkedAt": checked_at, "windows": windows});
    let extra = &limits["extra_usage"];
    if extra["is_enabled"] == true && extra["monthly_limit"].as_f64() == Some(0.0) {
        out["zeroSpendCap"] = json!(true);
    }
    out
}

// ---- The entry ----

struct Probe {
    installed: bool,
    version: Option<String>,
    status: &'static str,
    auth: Value,
    message: Option<String>,
    usage_limits: Option<Value>,
}

/// The entry's lists: models, models that need a newer CLI, slash commands.
struct Lists {
    models: Vec<Value>,
    update_required: Vec<Value>,
    slash_commands: Vec<Value>,
}

/// `buildServerProvider` with Claude's presentation, then `withInstanceIdentity`.
fn build_entry(
    instance_id: &str,
    settings: &StatusSettings,
    group_key: &str,
    checked_at: &str,
    lists: Lists,
    probe: Probe,
) -> Value {
    let mut entry = Map::new();
    entry.insert("displayName".into(), json!(DISPLAY_NAME));
    entry.insert("showInteractionModeToggle".into(), json!(true));
    entry.insert("reportsContextWindow".into(), json!(true));
    entry.insert("enabled".into(), json!(settings.enabled));
    entry.insert("installed".into(), json!(probe.installed));
    entry.insert("version".into(), json!(probe.version));
    let status = if settings.enabled {
        probe.status
    } else {
        "disabled"
    };
    entry.insert("status".into(), json!(status));
    entry.insert("auth".into(), probe.auth);
    entry.insert(
        "setup".into(),
        json!({"canAuthenticate": false, "canInstall": false}),
    );
    entry.insert("checkedAt".into(), json!(checked_at));
    if let Some(message) = probe.message {
        entry.insert("message".into(), json!(message));
    }
    entry.insert("models".into(), Value::Array(lists.models));
    if !lists.update_required.is_empty() {
        entry.insert(
            "updateRequiredModels".into(),
            Value::Array(lists.update_required),
        );
    }
    entry.insert("slashCommands".into(), Value::Array(lists.slash_commands));
    entry.insert("skills".into(), json!([]));
    if let Some(limits) = probe.usage_limits {
        entry.insert("usageLimits".into(), limits);
    }
    entry.insert("instanceId".into(), json!(instance_id));
    entry.insert("driver".into(), json!(DRIVER));
    if let Some(name) = &settings.display_name {
        entry.insert("displayName".into(), json!(name));
    }
    if let Some(color) = &settings.accent_color {
        entry.insert("accentColor".into(), json!(color));
    }
    entry.insert("continuation".into(), json!({"groupKey": group_key}));
    Value::Object(entry)
}

fn unknown_auth() -> Value {
    json!({"status": "unknown"})
}

fn compact_command() -> Value {
    json!({"name": "compact", "description": "Summarize the conversation and reduce context usage"})
}

/// `CLAUDE_EFFORT_LABELS`.
fn effort_label(id: &str) -> &str {
    match id {
        "low" => "Low",
        "medium" => "Medium",
        "high" => "High",
        "xhigh" => "Extra High",
        "max" => "Max",
        other => other,
    }
}

/// `claudeReportedModels`: models the CLI reports that the catalog does not know.
fn reported_models(catalog: &[CatalogModel], reported: &[Value]) -> Vec<Value> {
    // `stripClaudeContextWindowSuffix`: a trailing `[...]` goes.
    let strip = |id: &str| {
        let id = match (id.ends_with(']'), id.rfind('[')) {
            (true, Some(at)) => id.get(..at).unwrap_or(id),
            _ => id,
        };
        id.trim().to_lowercase()
    };
    let mut known: Vec<String> = catalog
        .iter()
        .flat_map(|entry| {
            let mut ids = vec![entry.model["slug"].as_str().unwrap_or("").to_owned()];
            ids.extend(
                entry.model["aliases"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_owned),
            );
            ids
        })
        .map(|id| strip(&id))
        .collect();
    let mut out = Vec::new();
    for info in reported {
        let slug = info["value"].as_str().unwrap_or("").trim();
        if slug.is_empty() || slug == "default" {
            continue;
        }
        let ids: Vec<String> = [slug, info["resolvedModel"].as_str().unwrap_or("")]
            .iter()
            .map(|id| strip(id))
            .filter(|id| !id.is_empty())
            .collect();
        if ids.iter().any(|id| known.contains(id)) {
            continue;
        }
        known.extend(ids);
        let name = info["displayName"]
            .as_str()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .unwrap_or(slug);
        let efforts: Vec<&str> = if info["supportsEffort"] == true {
            info["supportedEffortLevels"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect()
        } else {
            Vec::new()
        };
        let descriptors = if efforts.is_empty() {
            json!([])
        } else {
            json!([{"id": "effort", "label": "Reasoning", "type": "select",
                "options": std::iter::once(json!({"id": "default", "label": "Default", "isDefault": true}))
                    .chain(efforts.iter().map(|e| json!({"id": e, "label": effort_label(e)})))
                    .collect::<Vec<_>>()}])
        };
        out.push(json!({"slug": slug, "name": name, "isCustom": false,
            "capabilities": {"optionDescriptors": descriptors}}));
    }
    out
}

/// What one refresh needs from the outside: the version run and the host call.
#[derive(Debug)]
pub struct ProbeInput<'a> {
    pub instance_id: &'a str,
    pub settings: &'a StatusSettings,
    /// The server's environment (`login_env::child_env`).
    pub host_env: Vec<(String, String)>,
    /// `env.CLAUDE_CODE_ENTRYPOINT` from Claude's user or managed settings.
    pub settings_entrypoint: Option<String>,
    /// `ANTHROPIC_BASE_URL` from Claude's user or managed settings.
    pub settings_base_url: Option<String>,
    /// The folder probes run in (T3: its state folder).
    pub cwd: Option<PathBuf>,
    pub checked_at: String,
}

/// `checkClaudeProviderStatus`. `capabilities` runs the host probe with the option object.
pub async fn check<F, Fut>(input: ProbeInput<'_>, capabilities: F) -> Value
where
    F: FnOnce(Value, Value, Duration) -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    let settings = input.settings;
    let env = process_environment(settings, input.host_env, input.settings_entrypoint);
    let home = settings.resolved_home(&env);
    let group_key = format!("claude:home:{}", home.to_string_lossy());
    let catalog = catalog_models();
    let all_models: Vec<Value> = catalog.iter().map(|c| c.model.clone()).collect();
    let entry = |models, update_required, slash_commands, probe| {
        build_entry(
            input.instance_id,
            settings,
            &group_key,
            &input.checked_at,
            Lists {
                models,
                update_required,
                slash_commands,
            },
            probe,
        )
    };
    if !settings.enabled {
        return entry(
            all_models,
            vec![],
            vec![],
            Probe {
                installed: false,
                version: None,
                status: "warning",
                auth: unknown_auth(),
                message: Some("Claude is disabled in T3 Code settings.".into()),
                usage_limits: None,
            },
        );
    }
    let probe_env = probe_environment(&env);
    let error = |installed: bool, version: Option<String>, message: &str| Probe {
        installed,
        version,
        status: "error",
        auth: unknown_auth(),
        message: Some(message.to_owned()),
        usage_limits: None,
    };
    let version = spawn_and_collect(
        &settings.binary_path,
        &["--version"],
        &probe_env,
        input.cwd.as_deref(),
        probe_timeout(VERSION_TIMEOUT, &env),
    )
    .await;
    let result = match version {
        Err(CommandError::NotFound) => {
            return entry(
                all_models,
                vec![],
                vec![],
                error(
                    false,
                    None,
                    "Claude Agent CLI (`claude`) was not found on PATH.",
                ),
            );
        }
        Err(CommandError::Failed(_)) => {
            return entry(
                all_models,
                vec![],
                vec![],
                error(
                    true,
                    None,
                    "Failed to execute Claude Agent CLI health check.",
                ),
            );
        }
        Ok(None) => {
            return entry(
                all_models,
                vec![],
                vec![],
                error(
                    true,
                    None,
                    "Claude Agent CLI is installed but failed to run. Timed out while running command.",
                ),
            );
        }
        Ok(Some(result)) => result,
    };
    let version = parse_version(&result);
    if result.code != 0 {
        return entry(
            all_models,
            vec![],
            vec![],
            error(
                true,
                version,
                "Claude Agent CLI is installed but failed to run.",
            ),
        );
    }
    let update = update_required(&catalog, version.as_deref());
    let upgrade = upgrade_message(&catalog, version.as_deref());

    // `buildClaudeCapabilitiesProbeQueryOptions`.
    let mut sdk_env: Map<String, Value> = probe_env
        .iter()
        .map(|(k, v)| (k.clone(), json!(v)))
        .collect();
    sdk_env.insert("ENABLE_CLAUDEAI_MCP_SERVERS".into(), json!("false"));
    sdk_env.remove("FORCE_CODE_TERMINAL");
    sdk_env.insert("CLAUDE_CODE_AUTO_CONNECT_IDE".into(), json!("0"));
    sdk_env.insert("CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL".into(), json!("1"));
    let mut options = Map::new();
    options.insert("persistSession".into(), json!(false));
    options.insert(
        "pathToClaudeCodeExecutable".into(),
        json!(settings.binary_path),
    );
    options.insert("settingSources".into(), json!(["user", "project", "local"]));
    options.insert("settings".into(), json!({"disableAllHooks": true}));
    options.insert("allowedTools".into(), json!([]));
    options.insert("mcpServers".into(), json!({}));
    if !managed_mcp_config() {
        options.insert("strictMcpConfig".into(), json!(true));
    }
    options.insert("env".into(), Value::Object(sdk_env));
    if let Some(cwd) = &input.cwd {
        options.insert("cwd".into(), json!(cwd.to_string_lossy()));
    }
    let timeout = probe_timeout(CAPABILITIES_TIMEOUT, &env);
    let extra = json!({
        "includeStatus": true,
        "unsetEnv": ["FORCE_CODE_TERMINAL"],
        "timeoutMs": u64::try_from(timeout.as_millis()).unwrap_or(u64::MAX),
        "graceMs": gateway_grace_ms(&env, input.settings_base_url.as_deref()),
        "spawnThroughEnv": cfg!(target_os = "linux") && env_supports_chdir(),
    });
    let answer = capabilities(Value::Object(options), extra, timeout + HOST_CALL_SLACK).await;
    let commands = |caps: Option<&Capabilities>| {
        let mut list = vec![compact_command()];
        if let Some(caps) = caps {
            list.extend(caps.slash_commands.iter().cloned());
        }
        dedupe_commands(list)
    };
    let caps = answer.as_ref().ok().map(Capabilities::from_host);
    let mut models: Vec<Value> = catalog
        .iter()
        .filter(|m| supported(m, version.as_deref()))
        .map(|m| m.model.clone())
        .collect();
    if let Some(caps) = &caps {
        models.extend(reported_models(&catalog, &caps.models));
    }
    let Some(caps) = caps else {
        let message = match &answer {
            Err(e) if e.contains("timeout") => format!(
                "Timed out after {}s while checking Claude account status.",
                timeout.as_secs()
            ),
            _ => "Claude Agent CLI failed while checking account status.".to_owned(),
        };
        return entry(
            models,
            update,
            commands(None),
            Probe {
                installed: true,
                version,
                status: "warning",
                auth: unknown_auth(),
                message: Some(message),
                usage_limits: None,
            },
        );
    };
    let base_url = input
        .settings_base_url
        .clone()
        .or_else(|| get(&env, "ANTHROPIC_BASE_URL").map(str::to_owned));
    let endpoint = custom_endpoint(base_url.as_deref());
    if endpoint.is_none() && !caps.authenticated() {
        // T3 reads `CLAUDE_CONFIG_DIR` from the Claude environment; with one it names the
        // folder and the cwd (`claudeSignedOutMessage`, JSON-quoted paths).
        let message = match get(&env, "CLAUDE_CONFIG_DIR") {
            None => "Claude Code is not authenticated. Run `claude auth login` and try again."
                .to_owned(),
            Some(config_dir) => {
                let cwd = input
                    .cwd
                    .clone()
                    .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
                format!(
                    "Claude could not authenticate. For subscription login, run `claude auth login` on this environment's machine from {}, with CLAUDE_CONFIG_DIR set to {}, then start a new thread. For API-key authentication, check this instance's configured credentials.",
                    json!(cwd.to_string_lossy()),
                    json!(config_dir)
                )
            }
        };
        return entry(
            models,
            update,
            commands(Some(&caps)),
            Probe {
                installed: true,
                version,
                status: "error",
                auth: json!({"status": "unauthenticated"}),
                message: Some(message),
                usage_limits: None,
            },
        );
    }
    let mut auth = json!({"status": "authenticated"});
    if let Some(email) = caps.email.as_deref().filter(|e| !e.is_empty()) {
        auth["email"] = json!(email);
    }
    let metadata = if caps.api_provider.as_deref() == Some("bedrock") {
        auth_metadata(&caps).map(|(t, l)| json!({"type": t, "label": l}))
    } else if let Some(origin) = &endpoint {
        let mut m = json!({"type": "customEndpoint", "label": "Custom API endpoint"});
        if !origin.is_empty() {
            m["endpoint"] = json!(origin);
        }
        Some(m)
    } else {
        auth_metadata(&caps).map(|(t, l)| json!({"type": t, "label": l}))
    };
    if let Some(Value::Object(fields)) = metadata {
        for (k, v) in fields {
            auth[k] = v;
        }
    }
    let usage_at = caps
        .usage_checked_at
        .clone()
        .unwrap_or_else(|| input.checked_at.clone());
    let limits = match &caps.usage {
        None => usage_limits(None, &input.checked_at),
        Some(usage) => usage_limits(Some(usage), &usage_at),
    };
    entry(
        models,
        update,
        commands(Some(&caps)),
        Probe {
            installed: true,
            version,
            status: "ready",
            auth,
            message: upgrade,
            usage_limits: Some(limits),
        },
    )
}

/// `customClaudeApiEndpointHost`, giving the origin T3 shows as the endpoint.
fn custom_endpoint(base_url: Option<&str>) -> Option<String> {
    let url = base_url?.trim();
    let (scheme, rest) = url.split_once("://")?;
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority
        .rsplit('@')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .to_lowercase();
    if host.is_empty() || host == "api.anthropic.com" {
        return None;
    }
    Some(format!(
        "{scheme}://{}",
        authority.rsplit('@').next().unwrap_or("").to_lowercase()
    ))
}

/// `claudeGatewayDiscoveryGraceMs`.
fn gateway_grace_ms(env: &[(String, String)], settings_base_url: Option<&str>) -> u64 {
    let enabled = get(env, "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY")
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if enabled.is_empty() || enabled == "0" || enabled == "false" {
        return 0;
    }
    let base = settings_base_url.or_else(|| get(env, "ANTHROPIC_BASE_URL"));
    if base.is_none_or(|b| b.trim().is_empty()) {
        return 0;
    }
    get(env, "CLAUDE_CODE_GATEWAY_MODEL_DISCOVERY_TIMEOUT_MS")
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
        .map_or(3_000, |v| v as u64)
}

/// `hasClaudeManagedMcpConfig`.
pub(crate) fn managed_mcp_config() -> bool {
    let path = if cfg!(target_os = "macos") {
        "/Library/Application Support/ClaudeCode/managed-mcp.json"
    } else {
        "/etc/claude-code/managed-mcp.json"
    };
    std::path::Path::new(path).exists()
}

/// `supportsEnvChdir`: `/usr/bin/env -C / -- /bin/sh -c :` succeeds.
fn env_supports_chdir() -> bool {
    std::process::Command::new("/usr/bin/env")
        .args(["-C", "/", "--", "/bin/sh", "-c", ":"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_as_t3_semver() {
        use std::cmp::Ordering::*;
        assert_eq!(compare_versions("2.1.293", "2.1.280"), Greater);
        assert_eq!(compare_versions("2.1", "2.1.0"), Equal);
        assert_eq!(compare_versions("2.1.0-beta", "2.1.0"), Less);
        assert_eq!(compare_versions("2.1.0-beta.2", "2.1.0-beta.10"), Less);
        assert_eq!(compare_versions("v2.0.0", "1.9.9"), Greater);
    }

    #[test]
    fn the_version_is_the_first_triple_of_a_good_run() {
        let out = |stdout: &str, code| CommandOutput {
            stdout: stdout.into(),
            stderr: String::new(),
            code,
        };
        assert_eq!(
            parse_version(&out("2.1.293 (Claude Code)\n", 0)),
            Some("2.1.293".into())
        );
        assert_eq!(
            parse_version(&out("claude v2.1.5", 0)),
            Some("2.1.5".into())
        );
        assert_eq!(parse_version(&out("2.1.293", 1)), None);
        // As `/\bv?(\d+\.\d+\.\d+)\b/` in JavaScript.
        assert_eq!(parse_version(&out("1.2.3.4", 0)), Some("1.2.3".into()));
        assert_eq!(parse_version(&out("x2.1.3", 0)), None);
        assert_eq!(parse_version(&out("v2.1.3a", 0)), None);
    }

    #[test]
    fn an_old_cli_drops_newer_models_and_says_why() {
        let catalog = catalog_models();
        let models: Vec<&str> = catalog
            .iter()
            .filter(|m| supported(m, Some("2.1.200")))
            .filter_map(|m| m.model["slug"].as_str())
            .collect();
        assert!(!models.contains(&"claude-opus-5-5"));
        assert!(models.contains(&"claude-sonnet-4-6"));
        let message = upgrade_message(&catalog, Some("2.1.200")).unwrap();
        assert!(
            message.starts_with("Claude Code v2.1.200 is too old for"),
            "{message}"
        );
        assert!(catalog.iter().all(|m| supported(m, Some("9.0.0"))));
    }

    #[test]
    fn auth_follows_claude_auth_status() {
        let mut caps = Capabilities {
            token_source: Some("none".into()),
            ..Capabilities::default()
        };
        assert!(!caps.authenticated());
        caps.api_key_source = Some("ANTHROPIC_API_KEY".into());
        assert!(caps.authenticated());
        let pro = Capabilities {
            subscription_type: Some("claude_pro_subscription".into()),
            ..Capabilities::default()
        };
        assert_eq!(
            auth_metadata(&pro),
            Some((
                "claude_pro_subscription".into(),
                "Claude Pro Subscription".into()
            ))
        );
    }

    #[test]
    fn usage_windows_follow_claude_usage_response_to_limits() {
        let usage = json!({"rate_limits_available": true, "rate_limits": {
            "seven_day": {"utilization": 120, "resets_at": "2026-11-20T00:00:00Z"},
            "five_hour": {"utilization": 12.5},
            "model_scoped": [{"display_name": "Opus 5.5", "utilization": 3, "resets_at": null}],
        }});
        let limits = usage_limits(Some(&usage), "2026-11-14T00:00:00.000Z");
        let ids: Vec<&str> = limits["windows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["five_hour", "seven_day", "seven_day_opus_5_5"]);
        assert_eq!(limits["windows"][1]["usedPercent"], json!(100.0));
        assert_eq!(
            usage_limits(Some(&json!({"rate_limits_available": false})), "t")["unavailable"],
            json!({"reason": "unsupported"})
        );
    }
}
