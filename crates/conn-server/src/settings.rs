//! `settings.json`: the server settings, in the format `apps/server/src/serverSettings.ts`
//! keeps, so a home moves between the two servers without losing them.
//!
//! The file holds only what differs from the defaults (a sparse object). This server never
//! needs the defaults: it keeps the sparse object, merges each patch into it, and sends it to
//! clients as it is. `ServerSettings` decodes missing fields to their defaults, so clients see
//! the same settings the TypeScript server would send. A value set back to its default stays
//! in the file; both servers read that the same way.
//!
//! Patches follow `applyServerSettingsPatch` (`packages/shared/src/serverSettings.ts`): a deep
//! merge, with the replacements and entry maps listed in [`apply_patch`]. A patch must decode
//! as `ClientServerSettingsPatch` and the result as `ServerSettings`. Secrets stay in the file
//! (0600) instead of a secret store. They are redacted for clients per group, and a secret a
//! client echoes as `••••••` keeps its stored value; the groups and fields come from the T3
//! server (`settings/generated.rs`, by `tools/gen-upstream.mjs`). The TypeScript server moves
//! inline secrets into its store when it next starts.
//!
//! `crates/conn-server/tools/settings-diff.mjs` runs the T3 server's own functions and this
//! server on the same cases (`settings-cases.json`) and fails when they differ.

use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde_json::{Map, Value, json};
use tokio::sync::watch;

use conn_contract::{ClientServerSettingsPatch, ProviderInstanceMutation, ServerSettings};

use crate::auth::write_private;

/// What `redactServerSettingsForClient` shows instead of a saved secret.
pub const SECRET_REDACTED: &str = "\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}";

mod generated;

use generated::{
    BACKGROUND_PRESETS, CLIENT_PATCH_KEYS, CLOUD_SPEECH, EAS_DEVICE_HOST, PROJECT_OVERRIDE_KEYS,
    PROVIDER_CONFIG, SECRET_PROVIDER_KINDS, SIMLOCK_DEVICE_HOST, SOURCE_CONTROL_HOST,
    TEXT_GENERATOR, USAGE_LIMIT_SOURCE,
};

/// Drops the top-level keys that `ClientServerSettingsPatch` does not have, as the T3 server's
/// decode does: a client cannot set the theme defaults, which only the theme service writes.
fn keep_client_patch_keys(patch: &mut Map<String, Value>) {
    patch.retain(|key, _| CLIENT_PATCH_KEYS.contains(&key.as_str()));
}

/// Keys a patch replaces whole instead of merging.
const REPLACED: &[&str] = &[
    "providerInstances",
    "defaultModelSelection",
    "fallbackModelSelection",
    "speechPostProcessingModelSelection",
    "sourceControlWriterModelSelection",
    "reviewGuideModelSelection",
    "defaultProjectScripts",
    "favorites",
    "providerModelPreferences",
    "worktreeCleanup",
];
/// Maps whose entries a patch sets whole, or removes with `null`.
const ENTRY_MAPS: &[&str] = &[
    "usageLimitSources",
    "textGenerators",
    "secretProviders",
    "usagePriceOverrides",
    "usageModelAliases",
    "projectSettingsOverrides",
];
/// Legacy per-project maps and the `projectSettingsOverrides` key each one stands for
/// (`translateLegacyProjectOverridePatch`, `packages/shared/src/serverSettings.ts`).
const LEGACY_PROJECT_MAPS: &[(&str, &str)] = &[
    (
        "projectAgentBrowserAccessOverrides",
        "enableAgentBrowserAccess",
    ),
    ("projectAutoPullOverrides", "defaultAutoPull"),
    ("projectScriptOverrides", "defaultProjectScripts"),
];

#[derive(Debug)]
pub struct SettingsError {
    pub settings_path: String,
    pub operation: &'static str,
    pub detail: String,
    pub provider_instance_id: Option<String>,
}

impl SettingsError {
    /// `ServerSettingsError` as the contract encodes it.
    pub fn to_contract(&self) -> Value {
        let mut error = json!({
            "_tag": "ServerSettingsError",
            "settingsPath": self.settings_path,
            "operation": self.operation,
            "detail": self.detail,
        });
        if let Some(id) = &self.provider_instance_id {
            error["providerInstanceId"] = json!(id);
        }
        error
    }
}

pub struct SettingsStore {
    path: PathBuf,
    sparse: Mutex<Map<String, Value>>,
    /// Bumped after each write; `subscribeServerConfig` sends `settingsUpdated` on it.
    revision: watch::Sender<u64>,
}

impl std::fmt::Debug for SettingsStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The settings may hold secrets (provider keys, tokens).
        f.debug_struct("SettingsStore")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

impl SettingsStore {
    /// Reads `path`. A missing file is no settings; a malformed one is logged and treated the
    /// same, as the TypeScript server does, and is not rewritten until a client changes one.
    pub fn open(path: PathBuf) -> Self {
        let sparse = match read(&path) {
            Ok(sparse) => sparse,
            Err(error) => {
                eprintln!(
                    "conn-server: failed to parse {}, using defaults: {error}",
                    path.display()
                );
                Map::new()
            }
        };
        Self {
            path,
            sparse: Mutex::new(sparse),
            revision: watch::Sender::new(0),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The settings as stored, secrets included. For the server's own use.
    pub fn raw(&self) -> Map<String, Value> {
        self.lock().clone()
    }

    /// `ServerSettings` for clients: the stored settings with secrets redacted.
    pub fn for_client(&self) -> Value {
        let mut settings = self.raw();
        redact(&mut settings);
        Value::Object(settings)
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.revision.subscribe()
    }

    /// Applies a `server.updateSettings` patch, saves, and returns the client view.
    ///
    /// The patch must decode as `ClientServerSettingsPatch` and the mutation as
    /// `ProviderInstanceMutation`, and the result must decode as `ServerSettings`, so a client
    /// can never store settings that no client decodes. A secret a client echoes as `••••••`
    /// keeps its stored value (`persistSettingsSecrets`).
    pub fn update(&self, patch: Value, mutation: Option<Value>) -> Result<Value, SettingsError> {
        if let Err(error) = conn_contract::from_json::<ClientServerSettingsPatch>(patch.clone()) {
            return Err(self.error("normalize", format!("invalid settings patch: {error}")));
        }
        if let Some(mutation) = &mutation
            && let Err(error) =
                conn_contract::from_json::<ProviderInstanceMutation>(mutation.clone())
        {
            return Err(self.error(
                "normalize",
                format!("invalid provider instance mutation: {error}"),
            ));
        }
        let Value::Object(mut patch) = patch else {
            return Err(self.error("normalize", "the patch is not an object"));
        };
        keep_client_patch_keys(&mut patch);
        let mut sparse = self.lock();
        let mut next = sparse.clone();
        if let Some(mutation) = &mutation
            && mutation["operation"] == "create"
            && let Some(id) = mutation["instanceId"].as_str()
            && next
                .get("providerInstances")
                .and_then(|instances| instances.get(id))
                .is_some()
        {
            let mut error = self.error("create-provider-instance", "the provider instance exists");
            error.provider_instance_id = Some(id.to_owned());
            return Err(error);
        }
        apply_patch(&mut next, patch);
        if let Some(mutation) = mutation {
            apply_provider_instance_mutation(&mut next, mutation)
                .map_err(|detail| self.error("normalize", detail))?;
        }
        restore_echoed_secrets(&sparse, &mut next);
        if let Err(error) = conn_contract::from_json::<ServerSettings>(Value::Object(next.clone()))
        {
            return Err(self.error(
                "normalize",
                format!("the settings would not decode: {error}"),
            ));
        }
        let mut bytes =
            serde_json::to_vec(&next).map_err(|e| self.error("normalize", e.to_string()))?;
        bytes.push(b'\n');
        write_private(&self.path, &bytes).map_err(|e| self.error("write-file", e.to_string()))?;
        *sparse = next;
        drop(sparse);
        self.revision.send_modify(|r| *r += 1);
        Ok(self.for_client())
    }

    fn error(&self, operation: &'static str, detail: impl Into<String>) -> SettingsError {
        SettingsError {
            settings_path: self.path.display().to_string(),
            operation,
            detail: detail.into(),
            provider_instance_id: None,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Map<String, Value>> {
        crate::lock(&self.sparse)
    }
}

fn read(path: &Path) -> io::Result<Map<String, Value>> {
    match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(Value::Object(map)) => Ok(map),
            Ok(_) => Err(io::Error::new(io::ErrorKind::InvalidData, "not an object")),
            Err(error) => Err(io::Error::new(io::ErrorKind::InvalidData, error)),
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Map::new()),
        Err(error) => Err(error),
    }
}

/// `slot` as an object, replacing whatever else a hand-edited file left there.
fn ensure_object(slot: &mut Value) -> &mut Map<String, Value> {
    if !slot.is_object() {
        *slot = Value::Object(Map::new());
    }
    match slot {
        Value::Object(map) => map,
        _ => unreachable!("the slot was set to an object above"),
    }
}

/// `deepMerge`: objects merge key by key; anything else replaces.
fn deep_merge(current: &mut Value, patch: Value) {
    match (current, patch) {
        (Value::Object(current), Value::Object(patch)) => {
            for (key, value) in patch {
                match current.get_mut(&key) {
                    Some(existing) if existing.is_object() && value.is_object() => {
                        deep_merge(existing, value)
                    }
                    _ => {
                        current.insert(key, value);
                    }
                }
            }
        }
        (current, patch) => *current = patch,
    }
}

/// `mergeSettingsEntries`: each entry replaces, `null` removes.
fn merge_entries(current: &mut Map<String, Value>, key: &str, patch: Value) {
    let Value::Object(patch) = patch else {
        return;
    };
    let entries = ensure_object(current.entry(key).or_insert(Value::Null));
    for (id, value) in patch {
        if value.is_null() {
            entries.remove(&id);
        } else if key == "projectSettingsOverrides" {
            // `mergeProjectSettingsOverridesPatch`: the stored entry keeps keys this contract
            // does not know, the patch sets the keys it knows, and stored provider instances
            // stay unless the patch names them. An entry left empty is dropped.
            let stored = entries.get(&id).and_then(Value::as_object);
            let mut entry: Map<String, Value> = stored
                .into_iter()
                .flatten()
                .filter(|(k, _)| !PROJECT_OVERRIDE_KEYS.contains(&k.as_str()))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            let names_instances = value.get("providerInstances").is_some();
            if let Value::Object(patch_entry) = value {
                entry.extend(
                    patch_entry
                        .into_iter()
                        .filter(|(k, _)| PROJECT_OVERRIDE_KEYS.contains(&k.as_str())),
                );
            }
            if !names_instances
                && let Some(instances) = stored.and_then(|s| s.get("providerInstances"))
            {
                entry.insert("providerInstances".into(), instances.clone());
            }
            if entry.is_empty() {
                entries.remove(&id);
            } else {
                entries.insert(id, Value::Object(entry));
            }
        } else {
            entries.insert(id, value);
        }
    }
}

/// `applyServerSettingsPatch`, for the fields clients send.
pub fn apply_patch(settings: &mut Map<String, Value>, mut patch: Map<String, Value>) {
    translate_legacy_project_overrides(settings, &mut patch);
    let idle_compaction = patched_idle_compaction(settings, &patch);
    let background_profile = preset_background_profile(&patch);

    let set_favorites = patch.remove("setModelFavorites");
    let set_hidden = patch.remove("setModelsHidden");
    let set_order = patch.remove("setProviderModelOrder");
    let migrate = patch.remove("migrateModelPreferences");
    let selection = patch.remove("textGenerationModelSelection");

    for (key, value) in patch {
        if REPLACED.contains(&key.as_str()) {
            settings.insert(key, value);
        } else if ENTRY_MAPS.contains(&key.as_str()) {
            merge_entries(settings, &key, value);
        } else if key == "sourceControlHosts" {
            merge_source_control_hosts(settings, value);
        } else {
            let current = settings.entry(key).or_insert(Value::Null);
            deep_merge(current, value);
        }
    }

    // Model preferences: favorites, hidden models and order, from the stored value or the
    // client's migration of its local preferences.
    let migrate = migrate.unwrap_or(Value::Null);
    if let Some(Value::Array(changes)) = set_favorites {
        let mut favorites = settings
            .get("favorites")
            .filter(|v| v.is_array())
            .or_else(|| migrate.get("favorites"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for change in changes {
            let same =
                |f: &Value| f["provider"] == change["provider"] && f["model"] == change["model"];
            if change["favorite"] == true {
                if !favorites.iter().any(same) {
                    favorites
                        .push(json!({ "provider": change["provider"], "model": change["model"] }));
                }
            } else {
                favorites.retain(|f| !same(f));
            }
        }
        settings.insert("favorites".into(), Value::Array(favorites));
    }
    let preferences_base = |settings: &Map<String, Value>| {
        settings
            .get("providerModelPreferences")
            .filter(|v| v.is_object())
            .or_else(|| migrate.get("providerModelPreferences"))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
    };
    if let Some(Value::Array(changes)) = set_hidden
        && !changes.is_empty()
    {
        let mut preferences = preferences_base(settings);
        for change in changes {
            let Some(provider) = change["provider"].as_str() else {
                continue;
            };
            let entry = preferences
                .entry(provider)
                .or_insert_with(|| json!({ "hiddenModels": [], "modelOrder": [] }));
            let hidden = entry["hiddenModels"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let mut hidden: Vec<Value> = hidden
                .into_iter()
                .filter(|m| *m != change["model"])
                .collect();
            if change["hidden"] == true {
                hidden.push(change["model"].clone());
            }
            ensure_object(entry).insert("hiddenModels".into(), Value::Array(hidden));
        }
        settings.insert(
            "providerModelPreferences".into(),
            Value::Object(preferences),
        );
    }
    if let Some(order) = set_order
        && let Some(provider) = order["provider"].as_str()
    {
        let mut preferences = preferences_base(settings);
        let entry = preferences
            .entry(provider)
            .or_insert_with(|| json!({ "hiddenModels": [], "modelOrder": [] }));
        ensure_object(entry).insert("modelOrder".into(), order["modelOrder"].clone());
        settings.insert(
            "providerModelPreferences".into(),
            Value::Object(preferences),
        );
    }

    // `withIdleCompaction` and `deriveLegacyProjectOverrides`: every write stores the mode, the
    // legacy switch shipped clients read, and the legacy per-project maps.
    settings.insert("idleCompaction".into(), json!(idle_compaction));
    settings.insert(
        "compactIdleThreads".into(),
        json!(idle_compaction == "beforeCacheExpires"),
    );
    derive_legacy_project_overrides(settings);
    if let Some((profile, fetch, health)) = background_profile {
        settings.insert(
            "backgroundActivity".into(),
            json!({ "schemaVersion": 1, "profile": profile, "overrides": {} }),
        );
        settings.insert("backgroundActivityProfile".into(), json!(profile));
        settings.insert("automaticGitFetchInterval".into(), json!(fetch));
        settings.insert("providerHealthRefreshInterval".into(), json!(health));
    }

    // The text generation model: named fields replace, options merge by id.
    if let Some(Value::Object(selection)) = selection {
        let current = ensure_object(
            settings
                .entry("textGenerationModelSelection")
                .or_insert(Value::Null),
        );
        for (key, value) in selection {
            if key == "options"
                && let (Some(Value::Array(stored)), Value::Array(patch)) =
                    (current.get("options"), &value)
            {
                let mut merged = stored.clone();
                for option in patch {
                    match merged.iter_mut().find(|o| o["id"] == option["id"]) {
                        Some(existing) => *existing = option.clone(),
                        None => merged.push(option.clone()),
                    }
                }
                current.insert(key, Value::Array(merged));
            } else {
                current.insert(key, value);
            }
        }
    }
}

/// `translateLegacyProjectOverridePatch`: the legacy per-project maps become
/// `projectSettingsOverrides` entries. A project the patch names there keeps its canonical
/// entry; an entry left empty becomes `null` (removed).
fn translate_legacy_project_overrides(
    settings: &Map<String, Value>,
    patch: &mut Map<String, Value>,
) {
    let legacy: Vec<(&str, Map<String, Value>)> = LEGACY_PROJECT_MAPS
        .iter()
        .filter_map(|(map, key)| match patch.remove(*map) {
            Some(Value::Object(entries)) => Some((*key, entries)),
            _ => None,
        })
        .collect();
    if legacy.is_empty() {
        return;
    }
    let canonical: Vec<String> = patch
        .get("projectSettingsOverrides")
        .and_then(Value::as_object)
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    let mut entries = match patch.remove("projectSettingsOverrides") {
        Some(Value::Object(entries)) => entries,
        _ => Map::new(),
    };
    let stored = settings
        .get("projectSettingsOverrides")
        .and_then(Value::as_object);
    for (key, map) in legacy {
        for (project, value) in map {
            if canonical.contains(&project) {
                continue;
            }
            let base = match entries.get(&project) {
                Some(entry) => entry.as_object().cloned(),
                None => stored
                    .and_then(|s| s.get(&project))
                    .and_then(Value::as_object)
                    .cloned(),
            };
            let mut entry = base.unwrap_or_default();
            if value.is_null() {
                entry.remove(key);
            } else {
                entry.insert(key.into(), value);
            }
            let entry = if entry.is_empty() {
                Value::Null
            } else {
                Value::Object(entry)
            };
            entries.insert(project, entry);
        }
    }
    patch.insert("projectSettingsOverrides".into(), Value::Object(entries));
}

/// `patchedIdleCompaction`: the patch's mode, else the legacy switch it sends, else the stored
/// mode (`globalIdleCompaction`).
fn patched_idle_compaction(settings: &Map<String, Value>, patch: &Map<String, Value>) -> String {
    let global = |source: &Map<String, Value>| match (
        source.get("idleCompaction"),
        source.get("compactIdleThreads"),
    ) {
        (Some(Value::String(mode)), _) => mode.clone(),
        (_, Some(Value::String(mode))) => mode.clone(),
        (_, Some(Value::Bool(true))) => "beforeCacheExpires".into(),
        _ => "onReturn".into(),
    };
    if let Some(Value::String(mode)) = patch.get("idleCompaction") {
        return mode.clone();
    }
    match patch.get("compactIdleThreads") {
        Some(Value::String(mode)) => mode.clone(),
        Some(Value::Bool(true)) => "beforeCacheExpires".into(),
        Some(Value::Bool(false)) if global(settings) == "off" => "off".into(),
        Some(Value::Bool(false)) => "onReturn".into(),
        _ => global(settings),
    }
}

/// A patch that picks a background activity preset, and nothing custom: the preset and its
/// intervals (`applyServerSettingsPatch` with `normalizeBackgroundActivitySettings`). Custom
/// intervals are not ported yet; settings-diff.mjs lists that case as a known difference.
fn preset_background_profile(patch: &Map<String, Value>) -> Option<(&'static str, u64, u64)> {
    let custom = [
        "backgroundActivity",
        "automaticGitFetchInterval",
        "providerHealthRefreshInterval",
    ];
    if custom.iter().any(|key| patch.contains_key(*key)) {
        return None;
    }
    let profile = patch.get("backgroundActivityProfile")?.as_str()?;
    BACKGROUND_PRESETS
        .iter()
        .copied()
        .find(|(p, _, _)| *p == profile)
}

/// `deriveLegacyProjectOverrides`: the legacy per-project maps, read from the canonical entries.
fn derive_legacy_project_overrides(settings: &mut Map<String, Value>) {
    let entries = settings
        .get("projectSettingsOverrides")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (map, key) in LEGACY_PROJECT_MAPS {
        let derived: Map<String, Value> = entries
            .iter()
            .filter_map(|(project, entry)| Some((project.clone(), entry.get(*key)?.clone())))
            .collect();
        settings.insert((*map).into(), Value::Object(derived));
    }
}

/// Per host, a patched field replaces the saved one; a token map adds to the saved tokens.
fn merge_source_control_hosts(settings: &mut Map<String, Value>, patch: Value) {
    let Value::Object(patch) = patch else {
        return;
    };
    let hosts = ensure_object(settings.entry("sourceControlHosts").or_insert(Value::Null));
    for (kind, fields) in patch {
        let Value::Object(fields) = fields else {
            continue;
        };
        let saved = ensure_object(hosts.entry(kind).or_insert(Value::Null));
        for (field, value) in fields {
            if field == "tokens"
                && let Value::Object(tokens) = &value
                && !tokens.is_empty()
            {
                let mut merged = saved
                    .get("tokens")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                for (host, token) in tokens {
                    merged.insert(host.trim().to_lowercase(), token.clone());
                }
                saved.insert(field, Value::Object(merged));
            } else {
                saved.insert(field, value);
            }
        }
    }
}

/// `applyProviderInstanceMutation`: create, update or delete one `providerInstances` entry.
fn apply_provider_instance_mutation(
    settings: &mut Map<String, Value>,
    mutation: Value,
) -> Result<(), String> {
    let operation = mutation["operation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let id = mutation["instanceId"]
        .as_str()
        .ok_or("the mutation names no instanceId")?
        .to_owned();
    let instances = ensure_object(settings.entry("providerInstances").or_insert(Value::Null));
    match operation.as_str() {
        "create" | "upsert" => {
            let config = mutation
                .get("instance")
                .cloned()
                .ok_or("the mutation carries no instance")?;
            instances.insert(id, config);
            Ok(())
        }
        "remove" => {
            instances.remove(&id);
            Ok(())
        }
        other => Err(format!("unknown provider instance operation `{other}`")),
    }
}

/// One group of settings fields that may hold secrets: its place, and which fields.
struct SecretGroup<'a> {
    /// Names the group across two versions of the settings (`textGenerators/<id>`).
    key: String,
    fields: &'a mut Map<String, Value>,
    secret_fields: &'static [&'static str],
}

fn listed(
    table: &'static [(&'static str, &'static [&'static str])],
    name: &str,
) -> &'static [&'static str] {
    table
        .iter()
        .find(|(n, _)| *n == name)
        .map_or(&[], |(_, fields)| *fields)
}

/// Every secret group of `settings`, as `mapSecretFieldGroups` (`settingsSecrets.ts`) walks
/// them, and each provider instance's environment.
fn secret_groups(
    settings: &mut Map<String, Value>,
    group: &mut dyn FnMut(SecretGroup<'_>),
    environment: &mut dyn FnMut(&str, &mut Vec<Value>),
) {
    for (name, value) in settings.iter_mut() {
        match (name.as_str(), value) {
            ("cloudSpeechCredentials", Value::Object(fields)) => group(SecretGroup {
                key: name.clone(),
                fields,
                secret_fields: CLOUD_SPEECH,
            }),
            ("providerInstances", Value::Object(instances)) => {
                for (id, instance) in instances.iter_mut() {
                    let Value::Object(instance) = instance else {
                        continue;
                    };
                    let driver = instance
                        .get("driver")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    if let Some(Value::Object(config)) = instance.get_mut("config") {
                        group(SecretGroup {
                            key: format!("providerInstances/{id}/{driver}"),
                            fields: config,
                            secret_fields: listed(PROVIDER_CONFIG, &driver),
                        });
                    }
                    if let Some(Value::Array(variables)) = instance.get_mut("environment") {
                        environment(id, variables);
                    }
                }
            }
            ("sourceControlHosts", Value::Object(hosts)) => {
                for (kind, fields) in hosts.iter_mut() {
                    if let Value::Object(fields) = fields {
                        group(SecretGroup {
                            key: format!("sourceControlHosts/{kind}"),
                            fields,
                            secret_fields: listed(SOURCE_CONTROL_HOST, kind),
                        });
                    }
                }
            }
            (map @ ("usageLimitSources" | "textGenerators"), Value::Object(entries)) => {
                let secret_fields = if map == "usageLimitSources" {
                    USAGE_LIMIT_SOURCE
                } else {
                    TEXT_GENERATOR
                };
                for (id, fields) in entries.iter_mut() {
                    if let Value::Object(fields) = fields {
                        group(SecretGroup {
                            key: format!("{map}/{id}"),
                            fields,
                            secret_fields,
                        });
                    }
                }
            }
            (list @ ("easDeviceHosts" | "simlockDeviceHosts"), Value::Array(hosts)) => {
                let secret_fields = if list == "easDeviceHosts" {
                    EAS_DEVICE_HOST
                } else {
                    SIMLOCK_DEVICE_HOST
                };
                for fields in hosts.iter_mut() {
                    if let Value::Object(fields) = fields {
                        let id = fields
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned();
                        group(SecretGroup {
                            key: format!("{list}/{id}"),
                            fields,
                            secret_fields,
                        });
                    }
                }
            }
            _ => {}
        }
    }
}

/// `{ provider, reference }`: a secret kept by a secret provider, not a secret itself.
fn is_secret_reference(value: &Value) -> bool {
    value.get("provider").is_some_and(Value::is_string)
        && value.get("reference").is_some_and(Value::is_string)
}

/// The value a client sees for one stored secret: the marker for a saved one, including a
/// reference (a client without `secretReferences` decodes only strings).
fn redacted_secret(value: &Value) -> Value {
    match value {
        Value::String(s) if s.is_empty() => value.clone(),
        Value::String(_) => json!(SECRET_REDACTED),
        _ if is_secret_reference(value) => json!(SECRET_REDACTED),
        _ => value.clone(),
    }
}

/// `redactServerSettingsForClient` for a client without `secretReferences`: secret fields
/// show `••••••`, a field that maps server hosts to secrets shows it per host, sensitive
/// environment values show empty with `valueRedacted`, and a secret provider of a kind this
/// server does not know shows no `config`.
fn redact(settings: &mut Map<String, Value>) {
    secret_groups(
        settings,
        &mut |group| {
            for field in group.secret_fields {
                let Some(value) = group.fields.get_mut(*field) else {
                    continue;
                };
                let shown = match &*value {
                    Value::Object(hosts) if !is_secret_reference(value) => Value::Object(
                        hosts
                            .iter()
                            .map(|(host, secret)| {
                                (host.trim().to_lowercase(), redacted_secret(secret))
                            })
                            .collect(),
                    ),
                    other => redacted_secret(other),
                };
                *value = shown;
            }
        },
        &mut |_, variables| {
            for variable in variables.iter_mut() {
                let Value::Object(variable) = variable else {
                    continue;
                };
                let redacted = variable.remove("valueRedacted") == Some(Value::Bool(true));
                let value = variable.get("value").cloned().unwrap_or(Value::Null);
                if is_secret_reference(&value)
                    || variable.get("sensitive") != Some(&Value::Bool(true))
                {
                    continue;
                }
                let saved = redacted || value.as_str().is_some_and(|s| !s.is_empty());
                variable.insert("value".into(), json!(""));
                if saved {
                    variable.insert("valueRedacted".into(), json!(true));
                }
            }
        },
    );
    if let Some(Value::Object(providers)) = settings.get_mut("secretProviders") {
        for entry in providers.values_mut() {
            let known = entry
                .get("kind")
                .and_then(Value::as_str)
                .is_some_and(|kind| SECRET_PROVIDER_KINDS.contains(&kind));
            if !known && let Value::Object(entry) = entry {
                entry.remove("config");
            }
        }
    }
}

/// `persistSettingsSecrets` with `withEchoedSecretReferences`: a client shown `••••••` (or a
/// sensitive variable as `valueRedacted`) sends it back unchanged; the stored secret or
/// reference stays instead of the marker.
fn restore_echoed_secrets(current: &Map<String, Value>, next: &mut Map<String, Value>) {
    // The stored secrets, by group, field and server host.
    let mut saved: Vec<(String, Value)> = Vec::new();
    let mut saved_env: Vec<(String, Value)> = Vec::new();
    let mut current = current.clone();
    secret_groups(
        &mut current,
        &mut |group| {
            for field in group.secret_fields {
                match group.fields.get(*field) {
                    Some(value @ Value::Object(hosts)) if !is_secret_reference(value) => {
                        for (host, value) in hosts {
                            saved.push((
                                format!("{}/{field}/{}", group.key, host.trim().to_lowercase()),
                                value.clone(),
                            ));
                        }
                    }
                    Some(value) => saved.push((format!("{}/{field}", group.key), value.clone())),
                    None => {}
                }
            }
        },
        &mut |id, variables| {
            for variable in variables.iter() {
                if let Some(name) = variable.get("name").and_then(Value::as_str) {
                    saved_env.push((
                        format!("{id}/{name}"),
                        variable.get("value").cloned().unwrap_or(Value::Null),
                    ));
                }
            }
        },
    );
    let find = |list: &[(String, Value)], key: &str| {
        list.iter()
            .find(|(k, v)| {
                k == key
                    && (is_secret_reference(v)
                        || v.as_str()
                            .is_some_and(|s| !s.is_empty() && s != SECRET_REDACTED))
            })
            .map(|(_, v)| v.clone())
    };
    secret_groups(
        next,
        &mut |group| {
            for field in group.secret_fields {
                let Some(value) = group.fields.get_mut(*field) else {
                    continue;
                };
                match value {
                    Value::String(s) if s == SECRET_REDACTED => {
                        if let Some(old) = find(&saved, &format!("{}/{field}", group.key)) {
                            *value = old;
                        }
                    }
                    Value::Object(hosts) => {
                        for (host, secret) in hosts.iter_mut() {
                            if secret == SECRET_REDACTED
                                && let Some(old) = find(
                                    &saved,
                                    &format!(
                                        "{}/{field}/{}",
                                        group.key,
                                        host.trim().to_lowercase()
                                    ),
                                )
                            {
                                *secret = old;
                            }
                        }
                    }
                    _ => {}
                }
            }
        },
        &mut |id, variables| {
            for variable in variables.iter_mut() {
                let Value::Object(variable) = variable else {
                    continue;
                };
                let echoed = variable.get("valueRedacted") == Some(&Value::Bool(true))
                    && variable.get("value").is_none_or(|v| v == "");
                let name = variable
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                if echoed && let Some(old) = find(&saved_env, &format!("{id}/{name}")) {
                    variable.insert("value".into(), old);
                    variable.remove("valueRedacted");
                }
            }
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn patched(stored: Value, patch: Value) -> Value {
        let Value::Object(mut stored) = stored else {
            panic!()
        };
        let Value::Object(patch) = patch else {
            panic!()
        };
        apply_patch(&mut stored, patch);
        Value::Object(stored)
    }

    #[test]
    fn patches_merge_deeply_and_replace_what_typescript_replaces() {
        let stored = json!({
            "linkedEnvironmentsEnabled": true,
            "storageCleanup": { "worktreeAfterDays": 3, "worktreeOnMerge": true },
            "defaultModelSelection": { "instanceId": "codex", "model": "a", "options": [{ "id": "x", "value": 1 }] },
        });
        let next = patched(
            stored,
            json!({
                "storageCleanup": { "worktreeAfterDays": 5 },
                "defaultModelSelection": { "instanceId": "claudeAgent", "model": "b" },
                "enableAgentBrowserAccess": false,
            }),
        );
        assert_eq!(next["linkedEnvironmentsEnabled"], true);
        assert_eq!(
            next["storageCleanup"],
            json!({ "worktreeAfterDays": 5, "worktreeOnMerge": true })
        );
        assert_eq!(
            next["defaultModelSelection"],
            json!({ "instanceId": "claudeAgent", "model": "b" })
        );
        assert_eq!(next["enableAgentBrowserAccess"], false);
        // Every write stores the idle compaction mode, as the T3 server does.
        assert_eq!(next["idleCompaction"], "onReturn");
        assert_eq!(next["compactIdleThreads"], false);
    }

    #[test]
    fn a_client_patch_cannot_set_the_theme_defaults() {
        let Value::Object(mut patch) = json!({
            "defaultTheme": "dracula",
            "defaultThemeSetAt": "2026-11-14T00:00:00.000Z",
            "defaultAppearance": "dark",
            "defaultAppearanceSetAt": "2026-11-14T00:00:00.000Z",
            "notAKey": 1,
            "enableAgentBrowserAccess": true,
        }) else {
            panic!()
        };
        keep_client_patch_keys(&mut patch);
        assert_eq!(
            Value::Object(patch),
            json!({ "enableAgentBrowserAccess": true }),
            "only ClientServerSettingsPatch keys stay"
        );
    }

    #[test]
    fn entry_maps_set_and_remove_whole_entries() {
        let next = patched(
            json!({ "textGenerators": { "a": { "kind": "x", "url": "1" }, "b": { "kind": "y" } } }),
            json!({ "textGenerators": { "a": { "kind": "x" }, "b": null, "c": { "kind": "z" } } }),
        );
        assert_eq!(
            next["textGenerators"],
            json!({ "a": { "kind": "x" }, "c": { "kind": "z" } })
        );
    }

    #[test]
    fn legacy_project_maps_become_project_overrides() {
        let next = patched(
            json!({ "projectSettingsOverrides": { "p1": { "defaultAutoPull": true, "providerInstances": { "k": 1 } }, "p2": { "defaultAutoPull": true } } }),
            json!({ "projectScriptOverrides": { "p1": [] }, "projectAutoPullOverrides": { "p1": null, "p2": null } }),
        );
        assert_eq!(
            next["projectSettingsOverrides"],
            json!({ "p1": { "defaultProjectScripts": [], "providerInstances": { "k": 1 } } })
        );
        assert_eq!(next["projectScriptOverrides"], json!({ "p1": [] }));
        assert_eq!(next["projectAutoPullOverrides"], json!({}));
        // A canonical entry in the same patch wins.
        let next = patched(
            json!({}),
            json!({ "projectSettingsOverrides": { "p1": { "defaultAutoPull": false } }, "projectAutoPullOverrides": { "p1": true } }),
        );
        assert_eq!(
            next["projectSettingsOverrides"]["p1"],
            json!({ "defaultAutoPull": false })
        );
    }

    #[test]
    fn model_preference_operations_edit_the_lists() {
        let next = patched(
            json!({ "favorites": [{ "provider": "claudeAgent", "model": "a" }] }),
            json!({
                "setModelFavorites": [
                    { "provider": "claudeAgent", "model": "b", "favorite": true },
                    { "provider": "claudeAgent", "model": "a", "favorite": false },
                ],
                "setModelsHidden": [{ "provider": "codex", "model": "m", "hidden": true }],
                "setProviderModelOrder": { "provider": "codex", "modelOrder": ["m", "n"] },
            }),
        );
        assert_eq!(
            next["favorites"],
            json!([{ "provider": "claudeAgent", "model": "b" }])
        );
        assert_eq!(
            next["providerModelPreferences"],
            json!({ "codex": { "hiddenModels": ["m"], "modelOrder": ["m", "n"] } })
        );
    }

    #[test]
    fn text_generation_options_merge_by_id() {
        let next = patched(
            json!({ "textGenerationModelSelection": { "instanceId": "codex", "model": "a", "options": [{ "id": "effort", "value": "low" }, { "id": "fast", "value": true }] } }),
            json!({ "textGenerationModelSelection": { "model": "b", "options": [{ "id": "effort", "value": "high" }] } }),
        );
        assert_eq!(
            next["textGenerationModelSelection"],
            json!({ "instanceId": "codex", "model": "b", "options": [{ "id": "effort", "value": "high" }, { "id": "fast", "value": true }] })
        );
    }

    fn object(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(map) => map,
            _ => panic!("not an object"),
        }
    }

    #[test]
    fn secrets_are_redacted_per_group_for_clients() {
        let mut view = object(json!({
            "providerInstances": { "oc": { "driver": "opencode", "config": { "serverPassword": "pw", "apiKey": "not-a-secret-here" },
                "environment": [{ "name": "KEY", "value": "s3cret", "sensitive": true }, { "name": "MODE", "value": "x", "sensitive": false }] } },
            "sourceControlHosts": {
                "github": { "tokens": { "GitHub.com": "ghp" } },
                "gitcafe": { "token": "gc" },
                "bitbucket": { "accessToken": "a", "apiToken": "b" },
            },
            "cloudSpeechCredentials": { "openai": "sk", "xai": "" },
            "textGenerators": { "t": { "apiKey": { "provider": "op", "reference": "op://v/i/f" } } },
            "secretProviders": { "x": { "kind": "future", "config": { "token": "t" } } },
        }));
        redact(&mut view);
        let instance = &view["providerInstances"]["oc"];
        assert_eq!(instance["config"]["serverPassword"], SECRET_REDACTED);
        // Only the driver's own secret fields are secrets.
        assert_eq!(instance["config"]["apiKey"], "not-a-secret-here");
        assert_eq!(
            instance["environment"][0],
            json!({ "name": "KEY", "value": "", "sensitive": true, "valueRedacted": true })
        );
        assert_eq!(instance["environment"][1]["value"], "x");
        let hosts = &view["sourceControlHosts"];
        assert_eq!(hosts["github"]["tokens"]["github.com"], SECRET_REDACTED);
        assert_eq!(hosts["gitcafe"]["token"], SECRET_REDACTED);
        assert_eq!(hosts["bitbucket"]["apiToken"], SECRET_REDACTED);
        assert_eq!(
            view["cloudSpeechCredentials"],
            json!({ "openai": SECRET_REDACTED, "xai": "" })
        );
        assert_eq!(view["textGenerators"]["t"]["apiKey"], SECRET_REDACTED);
        assert_eq!(view["secretProviders"]["x"], json!({ "kind": "future" }));
    }

    #[test]
    fn echoed_markers_keep_the_stored_secrets() {
        let current = object(json!({
            "providerInstances": { "oc": { "driver": "opencode", "config": { "serverPassword": "pw" },
                "environment": [{ "name": "KEY", "value": "s3cret", "sensitive": true }] } },
            "textGenerators": { "t": { "apiKey": "key", "enabled": true } },
            "sourceControlHosts": { "github": { "tokens": { "github.com": "ghp" } } },
            "cloudSpeechCredentials": { "openai": { "provider": "op", "reference": "op://v/i/f" } },
        }));
        let mut next = current.clone();
        let mut view = current.clone();
        redact(&mut view);
        // The client edits what it was shown and sends it all back.
        next.insert(
            "providerInstances".into(),
            view["providerInstances"].clone(),
        );
        next["providerInstances"]["oc"]["displayName"] = json!("OpenCode");
        next.insert(
            "textGenerators".into(),
            json!({ "t": { "apiKey": SECRET_REDACTED, "enabled": false } }),
        );
        next.insert(
            "sourceControlHosts".into(),
            view["sourceControlHosts"].clone(),
        );
        next.insert(
            "cloudSpeechCredentials".into(),
            view["cloudSpeechCredentials"].clone(),
        );
        restore_echoed_secrets(&current, &mut next);
        let saved = &next["providerInstances"]["oc"];
        assert_eq!(saved["config"]["serverPassword"], "pw");
        assert_eq!(saved["environment"][0]["value"], "s3cret");
        assert_eq!(saved["environment"][0].get("valueRedacted"), None);
        assert_eq!(saved["displayName"], "OpenCode");
        assert_eq!(
            next["textGenerators"]["t"],
            json!({ "apiKey": "key", "enabled": false })
        );
        assert_eq!(
            next["sourceControlHosts"]["github"]["tokens"]["github.com"],
            "ghp"
        );
        assert_eq!(
            next["cloudSpeechCredentials"]["openai"],
            json!({ "provider": "op", "reference": "op://v/i/f" })
        );
    }

    #[test]
    fn updates_refuse_what_no_client_could_decode() {
        let dir =
            std::env::temp_dir().join(format!("conn-settings-{}", crate::auth::random_hex(6)));
        fs::create_dir_all(&dir).unwrap();
        let store = SettingsStore::open(dir.join("settings.json"));
        let error = store
            .update(json!({ "enableAgentBrowserAccess": "garbage" }), None)
            .unwrap_err();
        assert_eq!(error.operation, "normalize");
        assert!(store.raw().is_empty());
        store
            .update(json!({}), Some(json!({ "operation": "create", "instanceId": "cx", "instance": { "driver": "codex" } })))
            .unwrap();
        let error = store
            .update(json!({}), Some(json!({ "operation": "create", "instanceId": "cx", "instance": { "driver": "codex" } })))
            .unwrap_err();
        assert_eq!(error.to_contract()["operation"], "create-provider-instance");
        assert_eq!(error.to_contract()["providerInstanceId"], "cx");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn odd_shapes_in_a_hand_edited_file_never_panic() {
        let next = patched(
            json!({
                "providerModelPreferences": { "codex": 7 },
                "textGenerationModelSelection": "x",
                "sourceControlHosts": { "github": [] },
                "textGenerators": 3,
            }),
            json!({
                "setModelsHidden": [{ "provider": "codex", "model": "m", "hidden": true }],
                "setProviderModelOrder": { "provider": "codex", "modelOrder": ["m"] },
                "textGenerationModelSelection": { "model": "b" },
                "sourceControlHosts": { "github": { "tokens": { "GitHub.com": "t" } } },
                "textGenerators": { "a": { "kind": "x" } },
            }),
        );
        assert_eq!(
            next["providerModelPreferences"]["codex"]["modelOrder"],
            json!(["m"])
        );
        assert_eq!(
            next["sourceControlHosts"]["github"]["tokens"]["github.com"],
            "t"
        );
        let mut view = object(
            json!({ "providerInstances": { "x": { "environment": ["KEY", 3] } }, "tokens": 5 }),
        );
        redact(&mut view);
        let mut settings = Map::new();
        settings.insert(
            "providerInstances".into(),
            json!({ "x": { "environment": [1] } }),
        );
        apply_provider_instance_mutation(
            &mut settings,
            json!({ "operation": "upsert", "instanceId": "x", "instance": { "environment": [2, { "name": "K", "value": "", "valueRedacted": true }] } }),
        )
        .unwrap();
    }

    #[test]
    fn the_file_round_trips_and_writes_notify() {
        let dir =
            std::env::temp_dir().join(format!("conn-settings-{}", crate::auth::random_hex(6)));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        // What Orbit writes before the first start.
        fs::write(&path, "{\"linkedEnvironmentsEnabled\":true}\n").unwrap();
        let store = SettingsStore::open(path.clone());
        let mut revision = store.subscribe();
        let view = store
            .update(json!({ "enableAgentBrowserAccess": false }), None)
            .unwrap();
        assert_eq!(view["linkedEnvironmentsEnabled"], true);
        assert!(revision.has_changed().unwrap());
        revision.mark_unchanged();
        let saved: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved["linkedEnvironmentsEnabled"], true);
        assert_eq!(saved["enableAgentBrowserAccess"], false);
        assert_eq!(SettingsStore::open(path.clone()).raw(), store.raw());
        // A malformed file means defaults, and is left alone until a write.
        fs::write(&path, "{nope").unwrap();
        assert!(SettingsStore::open(path).raw().is_empty());
        fs::remove_dir_all(dir).unwrap();
    }
}
