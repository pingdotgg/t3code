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
//! as `ClientServerSettingsPatch` and the result as `ServerSettings`. Secrets live in the T3
//! server's secret store, `<state>/secrets/<name>.bin`, and the file holds `••••••` in their
//! place (`settings/secrets.rs`); a secret found inline moves to the store at start, as in T3.
//! Clients see secrets redacted per group, and a secret a client echoes as `••••••` keeps its
//! stored value; the groups and fields come from the T3 server (`settings/generated.rs`, by
//! `tools/gen-upstream.mjs`).
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

use conn_support::fs::write_private;

/// What `redactServerSettingsForClient` shows instead of a saved secret.
pub const SECRET_REDACTED: &str = "\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}";

mod generated;

mod secrets;

use generated::{
    BACKGROUND_PRESETS, CLIENT_PATCH_KEYS, DEFAULT_DISABLED_DRIVERS, DEFAULT_ENABLED_INSTANCES,
    PROJECT_OVERRIDE_KEYS,
};
use secrets::redact;

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

#[derive(Debug, thiserror::Error)]
#[error("{operation} {settings_path}: {detail}")]
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
    /// `<state>/secrets`, the T3 server's secret store.
    secrets_dir: PathBuf,
    state: Mutex<Loaded>,
    /// Bumped after each write; `subscribeServerConfig` sends `settingsUpdated` on it.
    revision: watch::Sender<u64>,
}

/// The settings in both forms.
struct Loaded {
    /// As the file holds them: `••••••` where a secret is saved.
    sparse: Map<String, Value>,
    /// With each saved secret read from the store, for the server's own use.
    materialized: Map<String, Value>,
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
    /// Reads `path` and the secret store beside it (`secrets/`). A missing file is no
    /// settings; a malformed one is logged and treated the same, as the TypeScript server
    /// does, and is not rewritten until a client changes one. A secret the file holds inline
    /// moves to the store, and the file is rewritten with the marker (`moveInlineSettingsSecrets`).
    /// Blocking: call it at start or from a blocking thread.
    pub fn open(path: PathBuf) -> Self {
        let secrets_dir = path
            .parent()
            .map_or_else(|| PathBuf::from("secrets"), |dir| dir.join("secrets"));
        let mut sparse = match read(&path) {
            Ok(sparse) => {
                if let Err(error) = conn_support::secret_store::ensure_dir(&secrets_dir) {
                    eprintln!(
                        "conn-server: failed to prepare {}: {error}",
                        secrets_dir.display()
                    );
                }
                sparse
            }
            Err(error) => {
                eprintln!(
                    "conn-server: failed to parse {}, using defaults: {error}",
                    path.display()
                );
                Map::new()
            }
        };
        if secrets::move_inline(&secrets_dir, &mut sparse)
            && let Err(error) = write_settings(&path, &sparse)
        {
            // The store holds the values now and the file still holds them inline; the next
            // start moves them again.
            eprintln!(
                "conn-server: failed to write {} after moving its secrets: {error}",
                path.display()
            );
        }
        let materialized = match secrets::materialize(&secrets_dir, &sparse) {
            Ok(materialized) => materialized,
            Err((name, error)) => {
                eprintln!("conn-server: failed to read settings secret {name}: {error}");
                sparse.clone()
            }
        };
        Self {
            path,
            secrets_dir,
            state: Mutex::new(Loaded {
                sparse,
                materialized,
            }),
            revision: watch::Sender::new(0),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The settings with their secrets, for the server's own use (`getSettings`).
    pub fn raw(&self) -> Map<String, Value> {
        self.lock().materialized.clone()
    }

    /// `ServerSettings` for clients: the settings with secrets redacted.
    pub fn for_client(&self) -> Value {
        let mut settings = self.raw();
        redact(&mut settings);
        Value::Object(settings)
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.revision.subscribe()
    }

    /// Applies a `server.updateSettings` patch, saves, and returns the client view.
    /// Blocking: it writes the secret store and the file.
    ///
    /// The patch must decode as `ClientServerSettingsPatch` and the mutation as
    /// `ProviderInstanceMutation`, and the result must decode as `ServerSettings`, so a client
    /// can never store settings that no client decodes. Secrets go to the store as
    /// `persistSettingsSecrets` sends them: a new value is written, a value a client echoes as
    /// `••••••` stays, a cleared one is removed; on a failure the store changes are undone.
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
        let mut state = self.lock();
        let mut next = state.sparse.clone();
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
        if let Err(error) = conn_contract::from_json::<ServerSettings>(Value::Object(next.clone()))
        {
            return Err(self.error(
                "normalize",
                format!("the settings would not decode: {error}"),
            ));
        }
        let changes = secrets::persist(&state.sparse, &mut next);
        let undo = secrets::apply(&self.secrets_dir, &changes)
            .map_err(|(operation, error)| self.error(operation, error.to_string()))?;
        let materialized = match secrets::materialize(&self.secrets_dir, &next) {
            Ok(materialized) => materialized,
            Err((_, error)) => {
                undo.run(&self.secrets_dir);
                return Err(self.error("read-secret", error.to_string()));
            }
        };
        if let Err(error) = write_settings(&self.path, &next) {
            undo.run(&self.secrets_dir);
            return Err(self.error("write-file", error));
        }
        *state = Loaded {
            sparse: next,
            materialized,
        };
        drop(state);
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

    fn lock(&self) -> std::sync::MutexGuard<'_, Loaded> {
        crate::lock(&self.state)
    }
}

/// Writes the file form, as `writeSettingsAtomically` (0600, a temp file and a rename).
fn write_settings(path: &Path, settings: &Map<String, Value>) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(settings).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    write_private(path, &bytes).map_err(|e| e.to_string())
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

/// `resolveProjectProviderInstanceEnabled`: the project's `providerInstances[id].enabled`
/// override when set, else the machine-wide `resolveProviderInstanceEnabled` of the instance's
/// entry (an explicit `false` on the envelope or in its `config` wins; then the envelope, the
/// config, the driver's default), else whether the id is a default instance that runs
/// unconfigured.
pub fn provider_instance_enabled(
    settings: &Map<String, Value>,
    project_id: Option<&str>,
    instance_id: &str,
) -> bool {
    let project_override = project_id.and_then(|project| {
        settings
            .get("projectSettingsOverrides")?
            .get(project)?
            .get("providerInstances")?
            .get(instance_id)?
            .get("enabled")?
            .as_bool()
    });
    if let Some(enabled) = project_override {
        return enabled;
    }
    let Some(instance) = settings
        .get("providerInstances")
        .and_then(|instances| instances.get(instance_id))
    else {
        return DEFAULT_ENABLED_INSTANCES.contains(&instance_id);
    };
    let envelope = instance.get("enabled").and_then(Value::as_bool);
    let config = instance
        .get("config")
        .filter(|c| c.is_object())
        .and_then(|c| c.get("enabled"))
        .and_then(Value::as_bool);
    if envelope == Some(false) || config == Some(false) {
        return false;
    }
    envelope.or(config).unwrap_or_else(|| {
        let driver = instance.get("driver").and_then(Value::as_str).unwrap_or("");
        !DEFAULT_DISABLED_DRIVERS.contains(&driver)
    })
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

    fn temp_state() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("conn-settings-{}", crate::auth::random_hex(6)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn stored(dir: &Path, name: &str) -> Option<String> {
        fs::read_to_string(dir.join("secrets").join(format!("{name}.bin"))).ok()
    }

    fn on_disk(dir: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(dir.join("settings.json")).unwrap()).unwrap()
    }

    /// Inline secrets as this server wrote them before it used the store.
    fn inline_settings() -> Value {
        json!({
            "providerInstances": { "oc": { "driver": "opencode", "config": { "serverPassword": "pw" },
                "environment": [{ "name": "KEY", "value": "s3cret", "sensitive": true }, { "name": "MODE", "value": "x", "sensitive": false }] } },
            "textGenerators": { "t": { "kind": "openaiCompatible", "label": "T", "baseUrl": "http://127.0.0.1:9/v1", "apiKey": "key", "enabled": true } },
            "sourceControlHosts": { "github": { "tokens": { "GitHub.com": "ghp" } }, "bitbucket": { "accessToken": "a" } },
            "cloudSpeechCredentials": { "openai": "sk", "xai": { "provider": "op", "reference": "op://v/i/f" } },
            "usageLimitSources": { "u": { "kind": "cliproxy", "url": "http://127.0.0.1:9", "managementKey": "mk" } },
        })
    }

    #[test]
    fn inline_secrets_move_to_the_store_at_start_under_t3_names() {
        let dir = temp_state();
        fs::write(dir.join("settings.json"), inline_settings().to_string()).unwrap();
        let store = SettingsStore::open(dir.join("settings.json"));
        // The names `mapSecretFieldGroups` gives (base64url parts).
        assert_eq!(
            stored(&dir, "provider-config-b2M-b3BlbmNvZGU-c2VydmVyUGFzc3dvcmQ").as_deref(),
            Some("pw")
        );
        assert_eq!(
            stored(&dir, "text-generator-dA-YXBpS2V5").as_deref(),
            Some("key")
        );
        assert_eq!(
            stored(&dir, "source-control-Z2l0aHVi-dG9rZW5z-Z2l0aHViLmNvbQ").as_deref(),
            Some("ghp")
        );
        assert_eq!(
            stored(&dir, "source-control-Yml0YnVja2V0-YWNjZXNzVG9rZW4").as_deref(),
            Some("a")
        );
        assert_eq!(stored(&dir, "voice-cloud-openai").as_deref(), Some("sk"));
        assert_eq!(stored(&dir, "usage-limit-source-dQ").as_deref(), Some("mk"));
        // Environment variables move on the next save, as in T3, not at start.
        assert_eq!(stored(&dir, "provider-env-b2M-S0VZ"), None);
        let file = on_disk(&dir);
        assert_eq!(file["textGenerators"]["t"]["apiKey"], SECRET_REDACTED);
        assert_eq!(
            file["sourceControlHosts"]["github"]["tokens"]["github.com"],
            SECRET_REDACTED
        );
        assert_eq!(file["cloudSpeechCredentials"]["xai"]["provider"], "op");
        assert_eq!(
            file["providerInstances"]["oc"]["environment"][0]["value"],
            "s3cret"
        );
        // The server's own view holds the values.
        let raw = Value::Object(store.raw());
        assert_eq!(raw["textGenerators"]["t"]["apiKey"], "key");
        assert_eq!(
            raw["providerInstances"]["oc"]["config"]["serverPassword"],
            "pw"
        );
        assert_eq!(
            raw["sourceControlHosts"]["github"]["tokens"]["github.com"],
            "ghp"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: PathBuf| fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(dir.join("secrets")), 0o700);
            assert_eq!(
                mode(dir.join("secrets/text-generator-dA-YXBpS2V5.bin")),
                0o600
            );
            assert_eq!(mode(dir.join("settings.json")), 0o600);
        }
        // No secret in a Debug output.
        assert!(!format!("{store:?}").contains("ghp"));
        // A second start finds nothing to move and the same values.
        let again = SettingsStore::open(dir.join("settings.json"));
        assert_eq!(again.raw(), store.raw());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn saves_write_keep_and_remove_stored_secrets() {
        let dir = temp_state();
        fs::write(dir.join("settings.json"), inline_settings().to_string()).unwrap();
        let store = SettingsStore::open(dir.join("settings.json"));
        let view = store.for_client();
        assert_eq!(view["textGenerators"]["t"]["apiKey"], SECRET_REDACTED);
        assert_eq!(view["cloudSpeechCredentials"]["xai"], SECRET_REDACTED);
        // The client edits what it was shown and sends it back: markers keep the values, and
        // the sensitive variable moves to the store now.
        let mut instances = view["providerInstances"].clone();
        instances["oc"]["displayName"] = json!("OpenCode");
        let answer = store
            .update(
                json!({
                    "providerInstances": instances,
                    "textGenerators": { "t": { "kind": "openaiCompatible", "label": "T", "baseUrl": "http://127.0.0.1:9/v1", "apiKey": SECRET_REDACTED, "enabled": false } },
                    "cloudSpeechCredentials": view["cloudSpeechCredentials"].clone(),
                }),
                None,
            )
            .unwrap();
        assert_eq!(answer["textGenerators"]["t"]["apiKey"], SECRET_REDACTED);
        assert_eq!(
            answer["providerInstances"]["oc"]["environment"][0]["value"],
            ""
        );
        assert_eq!(
            answer["providerInstances"]["oc"]["environment"][0]["valueRedacted"],
            true
        );
        assert_eq!(
            stored(&dir, "text-generator-dA-YXBpS2V5").as_deref(),
            Some("key")
        );
        assert_eq!(
            stored(&dir, "provider-env-b2M-S0VZ").as_deref(),
            Some("s3cret")
        );
        assert_eq!(
            stored(&dir, "provider-config-b2M-b3BlbmNvZGU-c2VydmVyUGFzc3dvcmQ").as_deref(),
            Some("pw")
        );
        let file = on_disk(&dir);
        assert_eq!(
            file["providerInstances"]["oc"]["environment"][0],
            json!({ "name": "KEY", "value": "", "sensitive": true, "valueRedacted": true })
        );
        assert_eq!(
            file["providerInstances"]["oc"]["environment"][1]["value"],
            "x"
        );
        assert_eq!(
            file["cloudSpeechCredentials"]["xai"]["reference"], "op://v/i/f",
            "the reference stays"
        );
        let raw = Value::Object(store.raw());
        assert_eq!(
            raw["providerInstances"]["oc"]["environment"][0]["value"],
            "s3cret"
        );
        assert_eq!(raw["providerInstances"]["oc"]["displayName"], "OpenCode");
        // A new value replaces, an empty one removes, a removed entry removes its secret.
        store
            .update(json!({ "textGenerators": { "t": { "kind": "openaiCompatible", "label": "T", "baseUrl": "http://127.0.0.1:9/v1", "apiKey": "new" } }, "cloudSpeechCredentials": { "openai": "" } }), None)
            .unwrap();
        assert_eq!(
            stored(&dir, "text-generator-dA-YXBpS2V5").as_deref(),
            Some("new")
        );
        assert_eq!(stored(&dir, "voice-cloud-openai"), None);
        assert_eq!(store.raw()["textGenerators"]["t"]["apiKey"], "new");
        store
            .update(json!({ "textGenerators": { "t": null } }), None)
            .unwrap();
        assert_eq!(stored(&dir, "text-generator-dA-YXBpS2V5"), None);
        // No secret value in the file.
        let text = fs::read_to_string(dir.join("settings.json")).unwrap();
        for secret in ["pw", "s3cret", "ghp", "\"mk\"", "new"] {
            assert!(!text.contains(secret), "{secret} is in the file");
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reads_a_state_folder_the_t3_server_wrote() {
        // What the T3 server leaves after it moved a key (names from `mapSecretFieldGroups`).
        let dir = temp_state();
        fs::write(
            dir.join("settings.json"),
            json!({
                "textGenerators": { "t": { "kind": "openaiCompatible", "label": "T", "baseUrl": "http://127.0.0.1:9/v1", "apiKey": SECRET_REDACTED } },
                "providerInstances": { "oc": { "driver": "opencode", "environment": [{ "name": "KEY", "value": "", "sensitive": true, "valueRedacted": true }] } },
                "easDeviceHosts": [{ "id": "h", "accessToken": SECRET_REDACTED }],
                "cloudSpeechCredentials": { "xai": SECRET_REDACTED },
            })
            .to_string(),
        )
        .unwrap();
        for (name, value) in [
            ("text-generator-dA-YXBpS2V5", "key"),
            ("provider-env-b2M-S0VZ", "s3cret"),
            ("device-host-aA-YWNjZXNzVG9rZW4", "eas"),
        ] {
            conn_support::secret_store::write(&dir.join("secrets"), name, value.as_bytes())
                .unwrap();
        }
        let store = SettingsStore::open(dir.join("settings.json"));
        let raw = Value::Object(store.raw());
        assert_eq!(raw["textGenerators"]["t"]["apiKey"], "key");
        assert_eq!(
            raw["providerInstances"]["oc"]["environment"][0]["value"],
            "s3cret"
        );
        assert_eq!(raw["easDeviceHosts"][0]["accessToken"], "eas");
        // A marker whose file is gone reads as no secret, and the client sees none.
        assert_eq!(raw["cloudSpeechCredentials"]["xai"], "");
        assert_eq!(store.for_client()["cloudSpeechCredentials"]["xai"], "");
        fs::remove_dir_all(dir).unwrap();
    }

    /// Source control host tokens the T3 server moved to its store reach the host code as
    /// tokens, never as the marker (the review's finding 3): GitHub sends the stored token,
    /// Bitbucket no longer drops it, and a marker whose file is gone reads as no token, so the
    /// environment's token is tried (the `github.rs` discovery table covers both paths).
    #[test]
    fn host_tokens_the_t3_server_moved_reach_source_control() {
        use conn_source_control::settings::{SecretSetting, Settings};
        let dir = temp_state();
        fs::write(
            dir.join("settings.json"),
            json!({
                "sourceControlHosts": {
                    "github": { "tokens": { "github.com": SECRET_REDACTED, "ghe.example.com": SECRET_REDACTED } },
                    "bitbucket": { "accessToken": SECRET_REDACTED },
                    "gitcafe": { "token": SECRET_REDACTED },
                },
            })
            .to_string(),
        )
        .unwrap();
        // `sourceControlHostSecretName`: kind, field and host, base64url.
        for (name, value) in [
            (
                "source-control-Z2l0aHVi-dG9rZW5z-Z2l0aHViLmNvbQ",
                "ghp-stored",
            ),
            ("source-control-Yml0YnVja2V0-YWNjZXNzVG9rZW4", "bb-stored"),
        ] {
            conn_support::secret_store::write(&dir.join("secrets"), name, value.as_bytes())
                .unwrap();
        }
        let store = SettingsStore::open(dir.join("settings.json"));
        // What `HostInputs::settings` builds for each call.
        let settings = Settings::new(store.raw());
        let literal = |setting: SecretSetting| match setting {
            SecretSetting::Literal(secret) => Some(secret.expose().to_owned()),
            _ => None,
        };
        assert_eq!(
            literal(settings.host("github").keyed_secret("tokens", "github.com")).as_deref(),
            Some("ghp-stored")
        );
        assert_eq!(
            literal(settings.host("bitbucket").secret_field("accessToken")).as_deref(),
            Some("bb-stored")
        );
        assert_eq!(
            settings
                .host("github")
                .keyed_secret("tokens", "ghe.example.com"),
            SecretSetting::Unset
        );
        assert_eq!(
            settings.host("gitcafe").secret_field("token"),
            SecretSetting::Unset
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_failed_settings_write_undoes_the_store_changes() {
        let dir = temp_state();
        let store = SettingsStore::open(dir.join("settings.json"));
        store
            .update(
                json!({ "cloudSpeechCredentials": { "openai": "old" } }),
                None,
            )
            .unwrap();
        // The settings file cannot be replaced: its path is now a folder.
        fs::remove_file(dir.join("settings.json")).unwrap();
        fs::create_dir(dir.join("settings.json")).unwrap();
        fs::write(dir.join("settings.json").join("x"), "").unwrap();
        let error = store
            .update(
                json!({ "cloudSpeechCredentials": { "openai": "new", "xai": "x" } }),
                None,
            )
            .unwrap_err();
        assert_eq!(error.operation, "write-file");
        assert!(!error.to_string().contains("new"));
        assert_eq!(stored(&dir, "voice-cloud-openai").as_deref(), Some("old"));
        assert_eq!(stored(&dir, "voice-cloud-xai"), None);
        assert_eq!(store.raw()["cloudSpeechCredentials"]["openai"], "old");
        fs::remove_dir_all(dir).unwrap();
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

    #[test]
    fn provider_instance_enabled_follows_t3() {
        let settings = |v: Value| v.as_object().cloned().unwrap();
        let empty = Map::new();
        assert!(provider_instance_enabled(&empty, None, "codex"));
        assert!(provider_instance_enabled(&empty, Some("p"), "claudeAgent"));
        assert!(!provider_instance_enabled(&empty, None, "grok"));
        let grok_on =
            settings(json!({"providerInstances": {"grok": {"driver": "grok", "enabled": true}}}));
        assert!(provider_instance_enabled(&grok_on, Some("p"), "grok"));
        let grok_default = settings(json!({"providerInstances": {"grok": {"driver": "grok"}}}));
        assert!(!provider_instance_enabled(&grok_default, None, "grok"));
        let config_off = settings(
            json!({"providerInstances": {"grok": {"driver": "grok", "enabled": true, "config": {"enabled": false}}}}),
        );
        assert!(!provider_instance_enabled(&config_off, None, "grok"));
        let unknown = settings(json!({"providerInstances": {"mine": {"driver": "fork"}}}));
        assert!(provider_instance_enabled(&unknown, None, "mine"));
        let project_off = settings(json!({
            "providerInstances": {"grok": {"driver": "grok", "enabled": true}},
            "projectSettingsOverrides": {"p": {"providerInstances": {"grok": {"enabled": false}}}},
        }));
        assert!(!provider_instance_enabled(&project_off, Some("p"), "grok"));
        assert!(provider_instance_enabled(&project_off, Some("q"), "grok"));
        assert!(provider_instance_enabled(&project_off, None, "grok"));
    }
}
