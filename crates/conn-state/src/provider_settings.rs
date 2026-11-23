//! Provider instance settings: which instances exist, whether each is on, and the writes that
//! change them (`ProviderSettingsPanel.tsx`, `ProviderInstanceCard.tsx`,
//! `ProviderSettingsForm.tsx`, `AddProviderInstanceDialog.tsx`, `contracts/src/settings.ts`).
//!
//! Pure and GPUI-free. Every write is a `server.updateSettings` payload with a
//! `providerInstanceMutation` (`create`, `upsert`, `remove`), built here so the iOS app sends the
//! same bytes. Settings are flat (`docs/scope.md` §2 #13): no per-project provider switches.

use conn_contract::{
    ServerProvidersItemItem, ServerSettings,
    ServerSettingsProviderInstancesValue as InstanceConfig,
    ServerSettingsProviderInstancesValueEnvironmentItem as EnvironmentVariable,
};
use serde_json::{Map, Value, json};

/// The longest instance id (`PROVIDER_SLUG_MAX_CHARS`).
pub const INSTANCE_ID_MAX_CHARS: usize = 64;
/// The longest slug a label turns into, so `${driver}_${slug}` fits the id cap.
const LABEL_SLUG_MAX_CHARS: usize = 48;

/// A configurable field of a driver's settings (`providerSettingsForm`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FieldDef {
    pub key: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub placeholder: &'static str,
    pub control: Control,
    /// `clearWhenEmpty: "omit"`: an empty value removes the key. `"persist"` stores it empty.
    pub omit_when_empty: bool,
    /// Kept in the server's secret store: a saved value arrives redacted and never shows.
    pub secret: bool,
}

/// How a field is edited.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Control {
    Text,
    Password,
    /// `(value, label)` options.
    Select(&'static [(&'static str, &'static str)]),
}

/// An environment variable a driver asks for by name (`environmentFields`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EnvField {
    pub name: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub placeholder: &'static str,
}

/// A provider driver Conn can configure (`providerClients.definitions`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DriverDef {
    pub kind: &'static str,
    pub label: &'static str,
    /// `hasDefaultInstance: false`: only custom instances exist (ACP Registry).
    pub has_default_instance: bool,
    pub fields: &'static [FieldDef],
    pub env_fields: &'static [EnvField],
}

const fn text(
    key: &'static str,
    title: &'static str,
    description: &'static str,
    placeholder: &'static str,
) -> FieldDef {
    FieldDef {
        key,
        title,
        description,
        placeholder,
        control: Control::Text,
        omit_when_empty: true,
        secret: false,
    }
}

const IDLE_COMPACTION: &[(&str, &str)] = &[
    ("default", "Use default"),
    ("onReturn", "When you return"),
    ("beforeCacheExpires", "Before the cache expires (beta)"),
    ("off", "Never"),
];

/// `ANTIGRAVITY_AUTH_METHODS`.
pub const ANTIGRAVITY_AUTH_METHODS: &[(&str, &str)] = &[
    ("oauth-personal", "Google account"),
    ("oauth-business", "Gemini Enterprise"),
    ("gemini-api-key", "Gemini API key"),
    ("agent-platform", "Agent Platform (Vertex AI)"),
];

const ACP_SOURCES: &[(&str, &str)] = &[("registry", "ACP Registry"), ("local", "Local command")];

/// The drivers, in `providerClients` order.
pub const DRIVERS: &[DriverDef] = &[
    DriverDef {
        kind: "codex",
        label: "Codex",
        has_default_instance: true,
        fields: &[
            text(
                "binaryPath",
                "Binary path",
                "Path to the Codex binary used by this instance.",
                "codex",
            ),
            text(
                "homePath",
                "CODEX_HOME path",
                "Custom Codex home and config directory.",
                "~/.codex",
            ),
            text(
                "shadowHomePath",
                "Shadow home path",
                "Account-specific Codex home. Keeps auth.json separate while sharing state from CODEX_HOME.",
                "~/.codex-t3/personal",
            ),
            text(
                "launchArgs",
                "Launch arguments",
                "Additional CLI arguments passed to codex app-server on session start.",
                "",
            ),
        ],
        env_fields: &[],
    },
    DriverDef {
        kind: "claudeAgent",
        label: "Claude",
        has_default_instance: true,
        fields: &[
            text(
                "binaryPath",
                "Binary path",
                "Path to the Claude binary used by this instance.",
                "claude",
            ),
            text(
                "homePath",
                "CLAUDE_CONFIG_DIR path",
                "Custom Claude home and config directory. Keeps .claude.json and .claude separate.",
                "~/.claude",
            ),
            text(
                "autoCompactWindow",
                "Auto-compact after",
                "Compact after 100,000 to 1,000,000 tokens. Leave empty to use Claude's default.",
                "e.g. 300000",
            ),
            FieldDef {
                key: "idleCompaction",
                title: "Compact idle threads",
                description: "When to compact an idle thread over 200,000 tokens: after you return, just before its prompt cache expires, or never. Overrides the default in Providers > Advanced.",
                placeholder: "",
                control: Control::Select(IDLE_COMPACTION),
                omit_when_empty: true,
                secret: false,
            },
            text(
                "launchArgs",
                "Launch arguments",
                "Additional CLI arguments passed on session start.",
                "e.g. --chrome",
            ),
        ],
        env_fields: &[],
    },
    DriverDef {
        kind: "cursor",
        label: "Cursor",
        has_default_instance: true,
        fields: &[],
        env_fields: &[EnvField {
            name: "CURSOR_API_KEY",
            label: "Cursor API key",
            description: "Optional. Overrides browser sign-in for this provider.",
            placeholder: "Paste API key",
        }],
    },
    DriverDef {
        kind: "grok",
        label: "Grok",
        has_default_instance: true,
        fields: &[text(
            "binaryPath",
            "Binary path",
            "Path to the Grok CLI binary.",
            "grok",
        )],
        env_fields: &[],
    },
    DriverDef {
        kind: "fx",
        label: "fx",
        has_default_instance: true,
        fields: &[text(
            "binaryPath",
            "Binary path",
            "Path to the fx binary. All fx instances on this machine share its fx login.",
            "fx",
        )],
        env_fields: &[],
    },
    DriverDef {
        kind: "opencode",
        label: "OpenCode",
        has_default_instance: true,
        fields: &[
            text(
                "binaryPath",
                "Binary path",
                "Path to the OpenCode binary.",
                "opencode",
            ),
            text(
                "serverUrl",
                "Server URL",
                "Leave blank to let Conn spawn the server when needed.",
                "http://127.0.0.1:4096",
            ),
            FieldDef {
                key: "serverPassword",
                title: "Server password",
                description: "Stored separately on the host.",
                placeholder: "Optional",
                control: Control::Password,
                omit_when_empty: true,
                secret: true,
            },
        ],
        env_fields: &[],
    },
    DriverDef {
        kind: "antigravity",
        label: "Antigravity",
        has_default_instance: true,
        fields: &[
            FieldDef {
                key: "authMethod",
                title: "Sign-in method",
                description: "Google accounts use your subscription; API keys and Agent Platform bill usage.",
                placeholder: "",
                control: Control::Select(ANTIGRAVITY_AUTH_METHODS),
                omit_when_empty: true,
                secret: false,
            },
            FieldDef {
                key: "apiKey",
                title: "API key",
                description: "Gemini or Vertex AI express key. Stored separately on the host.",
                placeholder: "Optional",
                control: Control::Password,
                omit_when_empty: true,
                secret: true,
            },
            text(
                "gcpProject",
                "GCP project",
                "Required for Gemini Enterprise. Agent Platform uses it when no API key is set.",
                "my-project-id",
            ),
            text(
                "gcpLocation",
                "GCP location",
                "Region for Gemini Enterprise or Agent Platform.",
                "us-central1",
            ),
            FieldDef {
                key: "binaryPath",
                title: "Binary path",
                description: "Custom ACP executable. Leave empty to select automatically.",
                placeholder: "Automatic",
                control: Control::Text,
                omit_when_empty: false,
                secret: false,
            },
        ],
        env_fields: &[],
    },
    DriverDef {
        kind: "kiro",
        label: "Kiro",
        has_default_instance: true,
        fields: &[text(
            "binaryPath",
            "Binary path",
            "Path to the Kiro CLI binary.",
            "kiro-cli",
        )],
        env_fields: &[EnvField {
            name: "KIRO_API_KEY",
            label: "Kiro API key",
            description: "Optional. Signs in without `kiro-cli login` (Kiro Pro and above).",
            placeholder: "Paste API key",
        }],
    },
    DriverDef {
        kind: "muse",
        label: "Muse Code",
        has_default_instance: true,
        fields: &[text(
            "binaryPath",
            "Binary path",
            "Path to the Muse Code binary on this environment. Sign in with muse login on that host.",
            "muse",
        )],
        env_fields: &[],
    },
    DriverDef {
        kind: "pi",
        label: "Pi",
        has_default_instance: true,
        fields: &[
            text(
                "binaryPath",
                "Binary path",
                "Path to the Pi coding agent binary.",
                "pi",
            ),
            text(
                "launchArgs",
                "Launch arguments",
                "Additional CLI arguments passed to pi --mode rpc on session start.",
                "",
            ),
        ],
        env_fields: &[],
    },
    DriverDef {
        kind: "acpRegistry",
        label: "ACP Registry",
        has_default_instance: false,
        fields: &[
            FieldDef {
                key: "source",
                title: "ACP source",
                description: "",
                placeholder: "",
                control: Control::Select(ACP_SOURCES),
                omit_when_empty: false,
                secret: false,
            },
            FieldDef {
                key: "agentId",
                title: "Registry agent ID",
                description: "Agent identifier from the official ACP Registry, for example 'devin'.",
                placeholder: "devin",
                control: Control::Text,
                omit_when_empty: false,
                secret: false,
            },
            text(
                "commandPath",
                "Executable override",
                "Executable on this environment. For registry agents, this overrides the distribution executable while keeping its arguments and environment.",
                "Registry default",
            ),
            text(
                "authMethodId",
                "Authentication method",
                "Optional ACP authentication method ID. By default, the first agent-managed method is selected.",
                "auto",
            ),
        ],
        env_fields: &[],
    },
];

/// The definition of `kind`, if this build knows the driver.
#[must_use]
pub fn driver_def(kind: &str) -> Option<&'static DriverDef> {
    DRIVERS.iter().find(|def| def.kind == kind)
}

/// Drivers whose default instance stays off until the user turns it on
/// (`DEFAULT_DISABLED_PROVIDER_DRIVERS`).
const DEFAULT_DISABLED_DRIVERS: &[&str] = &[
    "cursor",
    "grok",
    "fx",
    "kiro",
    "muse",
    "pi",
    "opencode",
    "antigravity",
];

/// `providerInstanceConfigEnabledFlag`: the legacy `enabled` inside the config blob.
fn config_enabled_flag(config: Option<&Value>) -> Option<bool> {
    config?.as_object()?.get("enabled")?.as_bool()
}

/// `resolveProviderInstanceEnabled`: an explicit `false` on the envelope or in the config wins,
/// else the envelope, the config, then the driver's default.
#[must_use]
pub fn resolve_instance_enabled(instance: &InstanceConfig) -> bool {
    let config_flag = config_enabled_flag(instance.config.as_ref());
    if instance.enabled == Some(false) || config_flag == Some(false) {
        return false;
    }
    instance
        .enabled
        .or(config_flag)
        .unwrap_or_else(|| !DEFAULT_DISABLED_DRIVERS.contains(&instance.driver.as_str()))
}

/// `isUnconfiguredDefaultInstanceEnabled`: with no settings entry, only Codex and Claude run.
#[must_use]
pub fn unconfigured_default_enabled(instance_id: &str) -> bool {
    matches!(instance_id, "codex" | "claudeAgent")
}

/// Whether `instance_id` is on in `settings`: its entry's setting, else the unconfigured
/// default.
#[must_use]
pub fn settings_instance_enabled(settings: &ServerSettings, instance_id: &str) -> bool {
    match settings
        .provider_instances
        .as_ref()
        .and_then(|instances| instances.get(instance_id))
    {
        Some(instance) => resolve_instance_enabled(instance),
        None => unconfigured_default_enabled(instance_id),
    }
}

/// One row of the Providers list (`InstanceRow`).
#[derive(Clone, Debug, PartialEq)]
pub struct InstanceRow {
    pub instance_id: String,
    pub driver: String,
    /// `None` for a default slot the user never configured.
    pub explicit: Option<InstanceConfig>,
    pub is_default: bool,
    /// The default slot has a settings entry.
    pub is_dirty: bool,
}

/// The rows of the Providers page, in `ProviderSettingsPanel`'s order: each known driver's
/// default slot (when it is worth showing), then its custom instances; instances of drivers
/// this build does not know come last. `show_cursor` is whether the server lists Cursor.
/// `target` keeps the default slot of the instance a setup link points at.
#[must_use]
pub fn instance_rows(
    settings: &ServerSettings,
    show_cursor: bool,
    target: Option<&str>,
) -> Vec<InstanceRow> {
    let empty = std::collections::BTreeMap::new();
    let instances = settings.provider_instances.as_ref().unwrap_or(&empty);
    let visible: Vec<&DriverDef> = DRIVERS
        .iter()
        .filter(|def| def.kind != "cursor" || show_cursor)
        .collect();
    let mut rows = Vec::new();
    for def in &visible {
        let explicit = instances.get(def.kind);
        let is_dirty = explicit.is_some();
        let has_default_slot = def.has_default_instance || explicit.is_some();
        let enabled = explicit.map_or_else(
            || !DEFAULT_DISABLED_DRIVERS.contains(&def.kind),
            resolve_instance_enabled,
        );
        if has_default_slot
            && (def.kind == "codex"
                || def.kind == "claudeAgent"
                || is_dirty
                || enabled
                || target == Some(def.kind))
        {
            rows.push(InstanceRow {
                instance_id: def.kind.to_owned(),
                driver: def.kind.to_owned(),
                explicit: explicit.cloned(),
                is_default: true,
                is_dirty,
            });
        }
        for (id, instance) in instances {
            if instance.driver == def.kind && id != def.kind {
                rows.push(InstanceRow {
                    instance_id: id.clone(),
                    driver: instance.driver.clone(),
                    explicit: Some(instance.clone()),
                    is_default: false,
                    is_dirty: false,
                });
            }
        }
    }
    for (id, instance) in instances {
        if visible.iter().any(|def| def.kind == instance.driver) {
            continue;
        }
        rows.push(InstanceRow {
            instance_id: id.clone(),
            driver: instance.driver.clone(),
            explicit: Some(instance.clone()),
            is_default: DRIVERS.iter().any(|def| def.kind == id),
            is_dirty: false,
        });
    }
    rows
}

/// The label of an instance row (`providerInstanceName`): its display name, else the driver's.
#[must_use]
pub fn instance_label(instance: &InstanceConfig) -> String {
    instance
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .or_else(|| driver_def(&instance.driver).map(|def| def.label.to_owned()))
        .unwrap_or_else(|| instance.driver.clone())
}

/// An empty instance of `driver` (`{ driver }`).
#[must_use]
pub fn blank_instance(driver: &str) -> InstanceConfig {
    InstanceConfig {
        driver: driver.to_owned(),
        display_name: None,
        accent_color: None,
        environment: None,
        enabled: None,
        config: None,
    }
}

/// `updateEnabled`: `{ ...instance, enabled }`.
#[must_use]
pub fn with_enabled(instance: &InstanceConfig, enabled: bool) -> InstanceConfig {
    InstanceConfig {
        enabled: Some(enabled),
        ..instance.clone()
    }
}

/// `updateDisplayName`: an empty name removes the key.
#[must_use]
pub fn with_display_name(instance: &InstanceConfig, name: &str) -> InstanceConfig {
    let trimmed = name.trim();
    InstanceConfig {
        display_name: (!trimmed.is_empty()).then(|| trimmed.to_owned()),
        ..instance.clone()
    }
}

/// `updateAccentColor`: only `#rrggbb` is kept.
#[must_use]
pub fn with_accent_color(instance: &InstanceConfig, color: &str) -> InstanceConfig {
    InstanceConfig {
        accent_color: crate::providers::normalize_accent_color(Some(color)),
        ..instance.clone()
    }
}

/// A config string, or `""` (`readProviderConfigString`).
#[must_use]
pub fn config_string(instance: &InstanceConfig, key: &str) -> String {
    instance
        .config
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|config| config.get(key))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// Whether a secret field has a saved value (it never shows).
#[must_use]
pub fn config_secret_saved(instance: &InstanceConfig, key: &str) -> bool {
    instance
        .config
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|config| config.get(key))
        .is_some_and(|value| match value {
            Value::String(text) => !text.is_empty(),
            Value::Null => false,
            _ => true,
        })
}

/// Claude's `autoCompactWindow` accepts nothing, or an integer from 100,000 to 1,000,000.
fn accepts_value(field: &FieldDef, value: &str) -> bool {
    if field.key == "autoCompactWindow" {
        return value.is_empty()
            || value == "1000000"
            || (value.len() == 6
                && value.chars().all(|c| c.is_ascii_digit())
                && !value.starts_with('0'));
    }
    true
}

/// `nextProviderConfigWithFieldValue` for a text value: an empty value removes an `omit` field
/// and is stored by a `persist` one. A value the field does not accept leaves the config as is.
/// A config left empty is removed.
#[must_use]
pub fn with_config_field(
    instance: &InstanceConfig,
    field: &FieldDef,
    value: &str,
) -> InstanceConfig {
    let mut config: Map<String, Value> = instance
        .config
        .as_ref()
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if field.omit_when_empty && value.trim().is_empty() {
        config.remove(field.key);
    } else if accepts_value(field, value) {
        config.insert(field.key.to_owned(), json!(value));
    }
    InstanceConfig {
        config: (!config.is_empty()).then_some(Value::Object(config)),
        ..instance.clone()
    }
}

/// An environment variable by name.
#[must_use]
pub fn environment_variable<'a>(
    instance: &'a InstanceConfig,
    name: &str,
) -> Option<&'a EnvironmentVariable> {
    instance
        .environment
        .as_ref()?
        .iter()
        .find(|variable| variable.name == name)
}

/// The variables that are not one of the driver's named fields (`providerEnvironmentWithoutNames`).
#[must_use]
pub fn generic_environment(
    instance: &InstanceConfig,
    driver: &DriverDef,
) -> Vec<EnvironmentVariable> {
    instance
        .environment
        .iter()
        .flatten()
        .filter(|variable| {
            !driver
                .env_fields
                .iter()
                .any(|field| field.name == variable.name)
        })
        .cloned()
        .collect()
}

/// A variable with a new plain value. Its saved redaction mark and secret reference go.
#[must_use]
pub fn variable(name: &str, value: &str, sensitive: bool) -> EnvironmentVariable {
    EnvironmentVariable {
        name: name.to_owned(),
        value: Some(value.to_owned()),
        sensitive: Some(sensitive),
        value_redacted: None,
        secret: None,
    }
}

/// `updateEnvironment`: variables without a name are dropped, and an empty list removes the key.
#[must_use]
pub fn with_environment(
    instance: &InstanceConfig,
    environment: Vec<EnvironmentVariable>,
) -> InstanceConfig {
    let cleaned: Vec<EnvironmentVariable> = environment
        .into_iter()
        .filter(|variable| !variable.name.trim().is_empty())
        .collect();
    InstanceConfig {
        environment: (!cleaned.is_empty()).then_some(cleaned),
        ..instance.clone()
    }
}

/// `updateEnvironmentField`: sets, or with an empty value removes, a driver's named variable.
#[must_use]
pub fn with_environment_field(
    instance: &InstanceConfig,
    name: &str,
    value: &str,
    sensitive: bool,
) -> InstanceConfig {
    let mut environment: Vec<EnvironmentVariable> = instance
        .environment
        .iter()
        .flatten()
        .filter(|variable| variable.name != name)
        .cloned()
        .collect();
    if !value.trim().is_empty() {
        environment.push(variable(name, value, sensitive));
    }
    with_environment(instance, environment)
}

/// `server.updateSettings` payload for `providerInstanceMutation: upsert`.
#[must_use]
pub fn upsert_request(instance_id: &str, instance: &InstanceConfig) -> Value {
    json!({
        "patch": {},
        "providerInstanceMutation": {
            "operation": "upsert",
            "instanceId": instance_id,
            "instance": instance,
        },
    })
}

/// `server.updateSettings` payload for `providerInstanceMutation: create` (Add provider).
#[must_use]
pub fn create_request(instance_id: &str, instance: &InstanceConfig) -> Value {
    json!({
        "patch": {},
        "providerInstanceMutation": {
            "operation": "create",
            "instanceId": instance_id,
            "instance": instance,
        },
    })
}

/// `server.updateSettings` payload for `providerInstanceMutation: remove`. Removing a default
/// slot resets it to its defaults.
#[must_use]
pub fn remove_request(instance_id: &str) -> Value {
    json!({
        "patch": {},
        "providerInstanceMutation": { "operation": "remove", "instanceId": instance_id },
    })
}

/// Whether resetting a default slot also turns the provider off (`turnsOff`).
#[must_use]
pub fn reset_turns_off(instance: &InstanceConfig) -> bool {
    resolve_instance_enabled(instance)
        && !resolve_instance_enabled(&blank_instance(&instance.driver))
}

/// `validateInstanceId`.
///
/// # Errors
///
/// Returns the message to show when `id` is empty, too long, malformed or taken.
pub fn validate_instance_id(id: &str, existing: &[&str]) -> Result<(), String> {
    if id.is_empty() {
        return Err("Instance ID is required.".to_owned());
    }
    if id.chars().count() > INSTANCE_ID_MAX_CHARS {
        return Err("Instance ID must be 64 characters or fewer.".to_owned());
    }
    let mut chars = id.chars();
    let starts_with_letter = chars.next().is_some_and(|c| c.is_ascii_alphabetic());
    if !starts_with_letter || !chars.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(
            "Instance ID must start with a letter and use only letters, digits, '-', or '_'."
                .to_owned(),
        );
    }
    if existing.contains(&id) {
        return Err(format!("An instance named '{id}' already exists."));
    }
    Ok(())
}

/// `slugifyLabel`: lowercase, runs of other characters become `_`, at most 48 characters.
fn slugify_label(value: &str) -> String {
    let mut slug = String::new();
    let mut pending_separator = false;
    for c in value.trim().to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if pending_separator && !slug.is_empty() {
                slug.push('_');
            }
            pending_separator = false;
            slug.push(c);
        } else {
            pending_separator = true;
        }
    }
    slug.chars().take(LABEL_SLUG_MAX_CHARS).collect()
}

/// `deriveAvailableInstanceId` with Add provider's base: the driver for the driver's own label,
/// else `${driver}_${slug}`, with `_2`, `_3`, ... added until the id is free.
#[must_use]
pub fn derive_available_instance_id(driver: &str, label: &str, existing: &[&str]) -> String {
    let default_label = driver_def(driver).map_or("", |def| def.label);
    let base = if label.trim().is_empty() || label == default_label {
        if driver == "acpRegistry" {
            format!("{driver}_custom")
        } else {
            driver.to_owned()
        }
    } else {
        let slug = slugify_label(label);
        if slug.is_empty() {
            String::new()
        } else {
            format!("{driver}_{slug}")
        }
    };
    if base.is_empty() || !existing.contains(&base.as_str()) {
        return base;
    }
    let mut suffix = 2_u32;
    loop {
        let suffix_text = format!("_{suffix}");
        let keep = INSTANCE_ID_MAX_CHARS - suffix_text.len();
        let candidate = format!(
            "{}{suffix_text}",
            base.chars().take(keep).collect::<String>()
        );
        if !existing.contains(&candidate.as_str()) {
            return candidate;
        }
        suffix += 1;
    }
}

/// The instance Add provider saves (`nextInstance`): enabled, with its label, accent and config.
#[must_use]
pub fn new_instance(
    driver: &str,
    label: &str,
    accent: &str,
    config: Option<Value>,
) -> InstanceConfig {
    let label = label.trim();
    InstanceConfig {
        driver: driver.to_owned(),
        display_name: (!label.is_empty()).then(|| label.to_owned()),
        accent_color: crate::providers::normalize_accent_color(Some(accent)),
        environment: None,
        enabled: Some(true),
        config,
    }
}

// --- text generation ----------------------------------------------------------------------

/// `DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection`.
#[must_use]
pub fn default_text_generation_selection() -> Value {
    json!({
        "instanceId": "codex",
        "model": "gpt-6-luna",
        "options": [{ "id": "reasoningEffort", "value": "low" }],
    })
}

/// The instance text generation (titles, commit messages) runs on
/// (`resolveAppModelSelectionState(...).instanceId`): the selected one while it is enabled
/// and available, else the first such instance that generates text.
#[must_use]
pub fn resolved_text_generation_instance(
    settings: &ServerSettings,
    providers: &[ServerProvidersItemItem],
) -> Option<String> {
    let selected = settings
        .text_generation_model_selection
        .as_ref()
        .and_then(|selection| selection.instance_id.clone().flatten())
        .and_then(|id| id.as_str().map(str::to_owned))
        .unwrap_or_else(|| "codex".to_owned());
    let usable = |provider: &&ServerProvidersItemItem| {
        provider.supports_text_generation != Some(false)
            && provider.enabled
            && !matches!(
                provider.availability,
                Some(conn_contract::ServerProvidersItemItemAvailability::Unavailable)
            )
    };
    providers
        .iter()
        .filter(usable)
        .find(|provider| provider.instance_id == selected)
        .or_else(|| providers.iter().find(usable))
        .map(|provider| provider.instance_id.clone())
}

/// `updateInstance`: the upsert, plus a reset of the text-generation model when this turns
/// off the instance text generation runs on, so titles and commit messages keep working.
#[must_use]
pub fn update_instance_request(
    settings: &ServerSettings,
    providers: &[ServerProvidersItemItem],
    instance_id: &str,
    previous: &InstanceConfig,
    next: &InstanceConfig,
) -> Value {
    let mut request = upsert_request(instance_id, next);
    let disabling = next.enabled == Some(false) && resolve_instance_enabled(previous);
    if disabling
        && resolved_text_generation_instance(settings, providers).as_deref() == Some(instance_id)
    {
        request["patch"]["textGenerationModelSelection"] = default_text_generation_selection();
    }
    request
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(value: &Value) -> ServerSettings {
        serde_json::from_value(value.clone()).expect("settings decode")
    }

    #[test]
    fn enablement_follows_the_envelope_then_the_config_then_the_driver() {
        let mut instance = blank_instance("antigravity");
        assert!(
            !resolve_instance_enabled(&instance),
            "Antigravity starts off"
        );
        instance.enabled = Some(true);
        assert!(resolve_instance_enabled(&instance));
        instance.config = Some(json!({ "enabled": false }));
        assert!(
            !resolve_instance_enabled(&instance),
            "an explicit false in the config is the most restrictive"
        );
        assert!(resolve_instance_enabled(&blank_instance("codex")));
        assert!(resolve_instance_enabled(&blank_instance("someForkDriver")));
    }

    #[test]
    fn an_instance_is_on_by_its_entry_else_by_the_unconfigured_default() {
        let settings = settings(&json!({
            "providerInstances": {
                "codex": { "driver": "codex" },
                "grok": { "driver": "grok", "enabled": true },
            },
        }));
        assert!(settings_instance_enabled(&settings, "codex"));
        assert!(!settings_instance_enabled(&settings, "pi"));
        assert!(settings_instance_enabled(&settings, "grok"));
        assert!(
            settings_instance_enabled(&settings, "claudeAgent"),
            "no entry: only Codex and Claude run"
        );
        assert!(!settings_instance_enabled(&settings, "kiro"));
    }

    #[test]
    fn rows_list_default_slots_worth_showing_then_custom_instances() {
        let settings = settings(&json!({
            "providerInstances": {
                "codex_work": { "driver": "codex", "displayName": "Work" },
                "antigravity": { "driver": "antigravity", "enabled": false },
                "acpRegistry_devin": { "driver": "acpRegistry" },
                "forkAgent_x": { "driver": "forkAgent" },
            },
        }));
        let rows = instance_rows(&settings, false, None);
        let ids: Vec<_> = rows.iter().map(|row| row.instance_id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "codex",
                "codex_work",
                "claudeAgent",
                "antigravity",
                "acpRegistry_devin",
                "forkAgent_x"
            ],
            "Codex and Claude always; Antigravity because it has an entry; off, unconfigured ones and Cursor are hidden"
        );
        assert!(rows[0].is_default && rows[0].explicit.is_none() && !rows[0].is_dirty);
        assert!(rows[3].is_dirty);
        let targeted = instance_rows(&settings, true, Some("grok"));
        assert!(
            targeted.iter().any(|row| row.instance_id == "grok"),
            "a setup link keeps its slot"
        );
        assert!(
            !targeted.iter().any(|row| row.instance_id == "cursor"),
            "Cursor is off and unconfigured"
        );
    }

    #[test]
    fn config_fields_omit_or_persist_empty_values() {
        let codex = driver_def("codex").expect("codex");
        let binary = &codex.fields[0];
        let instance = with_config_field(&blank_instance("codex"), binary, "/opt/codex");
        assert_eq!(config_string(&instance, "binaryPath"), "/opt/codex");
        let cleared = with_config_field(&instance, binary, "  ");
        assert_eq!(cleared.config, None, "an emptied config is removed");

        let antigravity = driver_def("antigravity").expect("antigravity");
        let binary = antigravity.fields.last().expect("binary path");
        let persisted = with_config_field(&blank_instance("antigravity"), binary, "");
        assert_eq!(
            persisted.config,
            Some(json!({ "binaryPath": "" })),
            "clearWhenEmpty persist"
        );

        let claude = driver_def("claudeAgent").expect("claude");
        let window = claude
            .fields
            .iter()
            .find(|f| f.key == "autoCompactWindow")
            .expect("window");
        let set = with_config_field(&blank_instance("claudeAgent"), window, "300000");
        assert_eq!(config_string(&set, "autoCompactWindow"), "300000");
        let rejected = with_config_field(&set, window, "5");
        assert_eq!(
            config_string(&rejected, "autoCompactWindow"),
            "300000",
            "out of range"
        );
    }

    #[test]
    fn environment_edits_drop_blank_names_and_keep_saved_secrets() {
        let mut instance = blank_instance("cursor");
        instance = with_environment_field(&instance, "CURSOR_API_KEY", "sk-1", true);
        assert_eq!(
            environment_variable(&instance, "CURSOR_API_KEY").and_then(|v| v.value.as_deref()),
            Some("sk-1")
        );
        let def = driver_def("cursor").expect("cursor");
        assert!(
            generic_environment(&instance, def).is_empty(),
            "named fields are not generic"
        );
        let mut generic = generic_environment(
            &with_environment(&instance, vec![variable("A", "1", false)]),
            def,
        );
        generic.push(variable("  ", "x", false));
        let next = with_environment(&instance, generic);
        assert_eq!(next.environment.as_ref().map(Vec::len), Some(1));
        let removed = with_environment_field(&instance, "CURSOR_API_KEY", "", true);
        assert_eq!(removed.environment, None);
    }

    #[test]
    fn writes_are_the_update_settings_payloads_conn_sends() {
        let mut instance = blank_instance("antigravity");
        instance = with_enabled(&instance, true);
        instance = with_display_name(&instance, " Work ");
        instance = with_accent_color(&instance, "#12abef");
        let request = upsert_request("antigravity", &instance);
        assert_eq!(
            request,
            json!({
                "patch": {},
                "providerInstanceMutation": {
                    "operation": "upsert",
                    "instanceId": "antigravity",
                    "instance": {
                        "driver": "antigravity", "displayName": "Work",
                        "accentColor": "#12abef", "enabled": true
                    },
                },
            })
        );
        assert_eq!(
            remove_request("codex_work"),
            json!({ "patch": {}, "providerInstanceMutation": { "operation": "remove", "instanceId": "codex_work" } })
        );
        assert_eq!(
            create_request("x", &instance)["providerInstanceMutation"]["operation"],
            "create"
        );
        assert!(reset_turns_off(&with_enabled(
            &blank_instance("antigravity"),
            true
        )));
        assert!(!reset_turns_off(&blank_instance("codex")));
    }

    #[test]
    fn instance_ids_are_derived_and_validated_like_the_add_dialog() {
        assert_eq!(derive_available_instance_id("codex", "Codex", &[]), "codex");
        assert_eq!(
            derive_available_instance_id("codex", "", &["codex"]),
            "codex_2"
        );
        assert_eq!(
            derive_available_instance_id("codex", "Work  Account!", &[]),
            "codex_work_account"
        );
        assert_eq!(
            derive_available_instance_id("codex", "Work", &["codex_work", "codex_work_2"]),
            "codex_work_3"
        );
        assert_eq!(
            derive_available_instance_id("acpRegistry", "", &[]),
            "acpRegistry_custom"
        );
        assert_eq!(derive_available_instance_id("codex", "???", &[]), "");
        assert!(validate_instance_id("codex_work", &["codex"]).is_ok());
        assert_eq!(
            validate_instance_id("", &[]).unwrap_err(),
            "Instance ID is required."
        );
        assert!(validate_instance_id("1abc", &[]).is_err());
        assert!(validate_instance_id("a b", &[]).is_err());
        assert_eq!(
            validate_instance_id("codex", &["codex"]).unwrap_err(),
            "An instance named 'codex' already exists."
        );
        assert!(validate_instance_id(&"a".repeat(65), &[]).is_err());
    }

    fn provider(id: &str, enabled: bool, text: Option<bool>) -> ServerProvidersItemItem {
        serde_json::from_value(json!({
            "instanceId": id, "driver": id, "enabled": enabled, "installed": true,
            "version": null, "status": "ready", "auth": { "status": "authenticated" },
            "checkedAt": "2026-01-01T00:00:00Z", "models": [], "slashCommands": [], "skills": [],
            "supportsTextGeneration": text,
        }))
        .expect("provider decode")
    }

    #[test]
    fn disabling_the_text_generation_instance_resets_the_selection() {
        let settings = settings(&json!({
            "textGenerationModelSelection": { "instanceId": "claudeAgent", "model": "haiku" },
        }));
        let providers = [
            provider("codex", true, None),
            provider("claudeAgent", true, None),
            provider("grok", true, Some(false)),
        ];
        assert_eq!(
            resolved_text_generation_instance(&settings, &providers).as_deref(),
            Some("claudeAgent")
        );
        let claude = blank_instance("claudeAgent");
        let request = update_instance_request(
            &settings,
            &providers,
            "claudeAgent",
            &claude,
            &with_enabled(&claude, false),
        );
        assert_eq!(
            request["patch"]["textGenerationModelSelection"],
            default_text_generation_selection()
        );
        let codex = blank_instance("codex");
        let other = update_instance_request(
            &settings,
            &providers,
            "codex",
            &codex,
            &with_enabled(&codex, false),
        );
        assert_eq!(
            other["patch"],
            json!({}),
            "codex does not run text generation here"
        );
        let fallback = settings_with_missing_selection();
        assert_eq!(
            resolved_text_generation_instance(&fallback, &providers[1..]).as_deref(),
            Some("claudeAgent"),
            "a disabled or missing selection falls to the first usable instance"
        );
    }

    fn settings_with_missing_selection() -> ServerSettings {
        settings(&json!({}))
    }
}
