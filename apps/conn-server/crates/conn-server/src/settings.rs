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
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde_json::{Map, Value, json};
use tokio::sync::watch;

use conn_contract::{ClientServerSettingsPatch, ProviderInstanceMutation};

use conn_support::fs::write_private;

/// What `redactServerSettingsForClient` shows instead of a saved secret.
pub const SECRET_REDACTED: &str = "\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}";

mod file;

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

/// The keys `ServerSettingsPatch` has beyond the client patch: the theme defaults.
const THEME_DEFAULT_KEYS: &[&str] = &[
    "defaultTheme",
    "defaultThemeSetAt",
    "defaultAppearance",
    "defaultAppearanceSetAt",
];

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
    /// What readers see. Held only to read or publish, never across file or SQLite work:
    /// readers run on the runtime thread.
    state: Mutex<Loaded>,
    /// Serializes saves, which reload, write and publish.
    writer: Mutex<()>,
    /// The last load failed in a way that may pass (a read, the provider history): the next
    /// admission reloads first ([`Self::reload_if_failed`]).
    retry: std::sync::atomic::AtomicBool,
    /// Loads [`Self::reload_if_failed`] ran.
    #[cfg(test)]
    reloads: std::sync::atomic::AtomicUsize,
    /// Bumped after each write; `subscribeServerConfig` sends `settingsUpdated` on it.
    revision: watch::Sender<u64>,
}

/// The settings in both forms.
struct Loaded {
    /// The whole document as the file holds it, `••••••` where a secret is saved, hosts this
    /// server does not serve included. Saves start from it.
    doc: Map<String, Value>,
    /// The served settings, each saved secret read from the store, for the server's own use.
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
    /// Reads `path` and the secret store beside it (`secrets/`); see [`load`].
    /// Blocking: call it at start or from a blocking thread.
    pub fn open(path: PathBuf) -> Self {
        let secrets_dir = path
            .parent()
            .map_or_else(|| PathBuf::from("secrets"), |dir| dir.join("secrets"));
        let (loaded, failure, retry) = load(&path, &secrets_dir);
        if let Some(error) = failure {
            eprintln!(
                "conn-server: failed to parse {}, using defaults: {error}",
                path.display()
            );
        }
        Self {
            path,
            secrets_dir,
            state: Mutex::new(loaded),
            writer: Mutex::new(()),
            retry: std::sync::atomic::AtomicBool::new(retry),
            #[cfg(test)]
            reloads: std::sync::atomic::AtomicUsize::new(0),
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
        with_idle_compaction(&mut settings);
        // `OmittedWhenNull`: a null `defaultThreadEnvMode` stays off the wire, so older
        // clients, which require a literal, keep decoding.
        if settings.get("defaultThreadEnvMode") == Some(&Value::Null) {
            settings.remove("defaultThreadEnvMode");
        }
        redact(&mut settings);
        Value::Object(settings)
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.revision.subscribe()
    }

    /// Whether the last load failed in a way that may since have passed.
    pub fn needs_reload(&self) -> bool {
        self.retry.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Loads again after a failure that may have passed, as T3 keeps a failed load for no
    /// time. Blocking: call it from a blocking thread.
    pub fn reload_if_failed(&self) {
        if !self.needs_reload() {
            return;
        }
        let _writer = crate::lock(&self.writer);
        // Another caller may have reloaded while this one waited for the writer.
        if !self.needs_reload() {
            return;
        }
        #[cfg(test)]
        self.reloads
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (reloaded, failure, retry) = load(&self.path, &self.secrets_dir);
        *self.lock() = reloaded;
        self.retry
            .store(retry, std::sync::atomic::Ordering::Relaxed);
        if failure.is_none() {
            self.revision.send_modify(|r| *r += 1);
        }
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
        self.update_with(patch, mutation, false)
    }

    /// `ServerSettingsService.updateSettings` from the server itself (the `/mcp` tools): as
    /// [`Self::update`], and the theme defaults that only the theme service sets are kept.
    pub fn update_server(&self, patch: Value) -> Result<Value, SettingsError> {
        self.update_with(patch, None, true)
    }

    fn update_with(
        &self,
        patch: Value,
        mutation: Option<Value>,
        theme_defaults: bool,
    ) -> Result<Value, SettingsError> {
        let mut theme = Map::new();
        // `30.0` is a whole number to T3: read it as one before the patch decodes.
        let mut patch = patch;
        file::normalize_numbers(&mut patch);
        let patch = match patch {
            Value::Object(mut map) if theme_defaults => {
                for key in THEME_DEFAULT_KEYS {
                    if let Some(value) = map.remove(*key) {
                        if !value.is_string() {
                            return Err(self.error("normalize", format!("invalid {key}")));
                        }
                        theme.insert((*key).to_owned(), value);
                    }
                }
                Value::Object(map)
            }
            other => other,
        };
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
        // A client cannot set the hosts this server does not serve; the file keeps its own.
        retain_supported_hosts(&mut patch);
        patch.extend(theme);
        let _writer = crate::lock(&self.writer);
        // T3's `updateAndPersistSettings` reloads first, so an edit made outside the server
        // survives an unrelated save, and a file the user broke is never replaced.
        let (reloaded, failure, retry) = load(&self.path, &self.secrets_dir);
        let current = reloaded.doc.clone();
        *self.lock() = reloaded;
        self.retry
            .store(retry, std::sync::atomic::Ordering::Relaxed);
        if let Some(detail) = failure {
            return Err(self.error("read-file", detail));
        }
        let mut next = current.clone();
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
        if let Err(error) = file::check(&next) {
            return Err(self.error(
                "normalize",
                format!("the settings would not decode: {error}"),
            ));
        }
        let changes = secrets::persist(&current, &mut next);
        let undo = secrets::apply(&self.secrets_dir, &changes)
            .map_err(|(operation, error)| self.error(operation, error.to_string()))?;
        let served = served(&next);
        let materialized = match secrets::materialize(&self.secrets_dir, &served) {
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
        *self.lock() = Loaded {
            doc: next,
            materialized,
        };
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

/// `loadSettingsFromDisk` ([`file::decode`]). A file that cannot be read, parsed or decoded
/// gives T3's conservative defaults and the reason; it stays on disk byte for byte for the
/// user to repair. Otherwise a secret the file holds inline moves to the store
/// (`moveInlineSettingsSecrets`), and the file is rewritten when that or the legacy provider
/// migration changed it. Both apply to the whole file; only the server's own view drops the
/// source control hosts it does not serve.
fn load(path: &Path, secrets_dir: &Path) -> (Loaded, Option<String>, bool) {
    let file::Decoded {
        mut doc,
        migrated,
        failure,
        retryable,
    } = file::decode(path);
    if failure.is_some() {
        let mut materialized = doc.clone();
        retain_supported_hosts(&mut materialized);
        return (Loaded { doc, materialized }, failure, retryable);
    }
    if let Err(error) = conn_support::secret_store::ensure_dir(secrets_dir) {
        eprintln!(
            "conn-server: failed to prepare {}: {error}",
            secrets_dir.display()
        );
    }
    let retired_secrets = secrets::move_legacy_hosts(secrets_dir, &mut doc);
    if secrets::move_inline(secrets_dir, &mut doc) || migrated || retired_secrets.is_some() {
        match write_settings(path, &doc) {
            Ok(()) => {
                for name in retired_secrets.unwrap_or_default() {
                    let _ = conn_support::secret_store::remove(secrets_dir, &name);
                }
            }
            // The store holds the values now and the file still holds them inline; the next
            // load moves them again.
            Err(error) => eprintln!(
                "conn-server: failed to write {} after migrating it: {error}",
                path.display()
            ),
        }
    }
    let served = served(&doc);
    let materialized = match secrets::materialize(secrets_dir, &served) {
        Ok(materialized) => materialized,
        Err((name, error)) => {
            eprintln!("conn-server: failed to read settings secret {name}: {error}");
            served
        }
    };
    (Loaded { doc, materialized }, None, false)
}

/// The settings this server serves: only the hosts it supports, and no retired legacy key.
fn served(doc: &Map<String, Value>) -> Map<String, Value> {
    let mut served = doc.clone();
    retain_supported_hosts(&mut served);
    for key in secrets::RETIRED_HOST_KEYS {
        served.remove(key);
    }
    served
}

/// Reloads `environment`'s settings on a blocking thread when their last load failed in a way
/// that may have passed, before a read or an admission uses them (T3 keeps a failed load for
/// no time).
pub async fn refresh(environment: &std::sync::Arc<crate::environment::Environment>) {
    if environment.settings.needs_reload() {
        let environment = environment.clone();
        let _ = tokio::task::spawn_blocking(move || environment.settings.reload_if_failed()).await;
    }
}

/// The settings as the store would load them, without writing anything: for a reader that
/// runs before the store opens (Grok's start settings). Blocking.
pub(crate) fn effective(path: &Path) -> Map<String, Value> {
    let mut doc = file::decode(path).doc;
    retain_supported_hosts(&mut doc);
    doc
}

/// Writes the file form, as `writeSettingsAtomically` (0600, a temp file and a rename). A
/// symlinked settings file keeps its link: the write goes to the link's target.
fn write_settings(path: &Path, settings: &Map<String, Value>) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(settings).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    let target = conn_support::fs::resolve_symlink_target(path).map_err(|e| e.to_string())?;
    write_private(&target, &bytes).map_err(|e| e.to_string())
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

/// `applyServerSettingsPatch`, for the fields clients send. A client cannot set a source
/// control host this server does not serve; the settings keep the ones they hold.
pub fn apply_patch(settings: &mut Map<String, Value>, mut patch: Map<String, Value>) {
    retain_supported_hosts(&mut patch);
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

/// `globalIdleCompaction`: the stored mode, else the legacy switch, else `onReturn`.
fn global_idle_compaction(source: &Map<String, Value>) -> String {
    match (
        source.get("idleCompaction"),
        source.get("compactIdleThreads"),
    ) {
        (Some(Value::String(mode)), _) => mode.clone(),
        (_, Some(Value::String(mode))) => mode.clone(),
        (_, Some(Value::Bool(true))) => "beforeCacheExpires".into(),
        _ => "onReturn".into(),
    }
}

/// `withIdleCompaction(settings, globalIdleCompaction(settings))`, which T3 applies when it
/// loads the settings: clients see the mode (so they know this server reads modes) and the
/// legacy switch, even before the first write.
fn with_idle_compaction(settings: &mut Map<String, Value>) {
    let mode = global_idle_compaction(settings);
    settings.insert(
        "compactIdleThreads".into(),
        json!(mode == "beforeCacheExpires"),
    );
    settings.insert("idleCompaction".into(), json!(mode));
}

/// `patchedIdleCompaction`: the patch's mode, else the legacy switch it sends, else the stored
/// mode (`globalIdleCompaction`).
fn patched_idle_compaction(settings: &Map<String, Value>, patch: &Map<String, Value>) -> String {
    let global = global_idle_compaction;
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

pub(super) fn retain_supported_hosts(settings: &mut Map<String, Value>) {
    for key in ["sourceControlHosts", "offeredSourceControlProviders"] {
        if let Some(Value::Object(hosts)) = settings.get_mut(key) {
            hosts.retain(|kind, _| kind == "github");
        }
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

/// Browser access is captured in the MCP credential when a provider session starts.
pub fn agent_browser_access(settings: &Map<String, Value>, project_id: Option<&str>) -> bool {
    project_id
        .and_then(|id| {
            settings
                .get("projectSettingsOverrides")?
                .get(id)?
                .get("enableAgentBrowserAccess")?
                .as_bool()
        })
        .or_else(|| settings.get("enableAgentBrowserAccess")?.as_bool())
        .unwrap_or(generated::DEFAULT_AGENT_BROWSER_ACCESS)
}

/// `resolveProjectSettings(settings, projectId).settings.removeAgentCreditsOnMerge`: the
/// project's override when set, else the machine-wide value, else T3's default `false`.
pub fn remove_agent_credits_on_merge(settings: &Map<String, Value>, project_id: &str) -> bool {
    settings
        .get("projectSettingsOverrides")
        .and_then(|overrides| {
            overrides
                .get(project_id)?
                .get("removeAgentCreditsOnMerge")?
                .as_bool()
        })
        .or_else(|| settings.get("removeAgentCreditsOnMerge")?.as_bool())
        .unwrap_or(false)
}

/// `resolveProjectSettings(settings, projectId).settings.responseStreamingMode`: the
/// project's override when set, else the machine-wide value, else T3's default `paragraph`.
pub fn response_streaming_mode(
    settings: &Map<String, Value>,
    project_id: Option<&str>,
) -> conn_engine::ResponseStreamingMode {
    let project = project_id.and_then(|project| {
        settings
            .get("projectSettingsOverrides")?
            .get(project)?
            .get("responseStreamingMode")?
            .as_str()
    });
    let value = project.or_else(|| settings.get("responseStreamingMode")?.as_str());
    conn_engine::ResponseStreamingMode::from_setting(value)
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
    use std::fs;

    use conn_contract::ServerSettings;

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
    fn unsupported_host_settings_are_ignored_on_load_and_update() {
        let dir = temp_state();
        let old = json!({"sourceControlHosts": {
            "github": {"tokens": {"github.com": "ghp"}},
            "gitlab": {"tokens": {"gitlab.com": "old"}},
            "bitbucket": {"accessToken": "old"},
            "gitcafe": {"token": "old"},
            "forgejo": {"tokens": {"codeberg.org": "old"}},
            "azure-devops": {}, "cursor-origin": {}
        }, "offeredSourceControlProviders": {
            "github": false, "gitlab": true, "bitbucket": true,
            "forgejo": true, "gitcafe": true, "azure-devops": true, "cursor-origin": true
        }});
        fs::write(dir.join("settings.json"), old.to_string()).expect("settings");
        let store = SettingsStore::open(dir.join("settings.json"));
        assert_eq!(
            store
                .raw()
                .get("sourceControlHosts")
                .and_then(Value::as_object)
                .map(Map::len),
            Some(1)
        );
        assert_eq!(
            store.for_client()["sourceControlHosts"],
            json!({"github": {"tokens": {"github.com": SECRET_REDACTED}}})
        );
        assert_eq!(
            store.for_client()["offeredSourceControlProviders"],
            json!({"github": false})
        );
        let answer = store.update(old, None).expect("update");
        assert_eq!(
            answer["offeredSourceControlProviders"],
            json!({"github": false})
        );
        // The file keeps the hosts this server does not serve, as the file had them.
        assert_eq!(
            on_disk(&dir)["offeredSourceControlProviders"],
            json!({"github": false, "gitlab": true, "bitbucket": true,
                   "forgejo": true, "gitcafe": true, "azure-devops": true, "cursor-origin": true})
        );
        assert_eq!(
            answer["sourceControlHosts"],
            json!({"github": {"tokens": {"github.com": SECRET_REDACTED}}})
        );
        let hosts = on_disk(&dir)["sourceControlHosts"].clone();
        assert_eq!(hosts["github"], answer["sourceControlHosts"]["github"]);
        for kind in [
            "gitlab",
            "bitbucket",
            "gitcafe",
            "forgejo",
            "azure-devops",
            "cursor-origin",
        ] {
            assert!(hosts.get(kind).is_some(), "{kind} stays on disk");
        }
        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn secrets_are_redacted_per_group_for_clients() {
        let mut view = object(json!({
            "providerInstances": { "oc": { "driver": "opencode", "config": { "serverPassword": "pw", "apiKey": "not-a-secret-here" },
                "environment": [{ "name": "KEY", "value": "s3cret", "sensitive": true }, { "name": "MODE", "value": "x", "sensitive": false }] } },
            "sourceControlHosts": {
                "github": { "tokens": { "GitHub.com": "ghp" } },
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
        assert_eq!(
            view["cloudSpeechCredentials"],
            json!({ "openai": SECRET_REDACTED, "xai": "" })
        );
        assert_eq!(view["textGenerators"]["t"]["apiKey"], SECRET_REDACTED);
        assert_eq!(view["secretProviders"]["x"], json!({ "kind": "future" }));
    }

    /// Clients cannot set the theme defaults (`ClientServerSettingsPatch`); the theme service
    /// can (`ServerSettingsPatch`).
    #[test]
    fn only_the_server_sets_theme_defaults() {
        let dir = temp_state();
        let store = SettingsStore::open(dir.join("settings.json"));
        let patch = json!({ "defaultTheme": "night", "defaultThemeSetAt": "2026-11-20T00:00:00.000Z",
            "defaultAppearance": "dark", "defaultAppearanceSetAt": "2026-11-20T00:00:00.000Z" });
        store.update(patch.clone(), None).unwrap();
        assert!(store.raw().get("defaultTheme").is_none_or(|t| t == ""));
        store.update_server(patch).unwrap();
        assert_eq!(store.raw()["defaultTheme"], "night");
        assert_eq!(store.raw()["defaultAppearance"], "dark");
        assert!(
            store
                .update_server(json!({ "defaultAppearance": "sepia" }))
                .is_err()
        );
        assert!(store.update_server(json!({ "defaultTheme": 5 })).is_err());
        let _ = std::fs::remove_dir_all(dir);
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
            "sourceControlHosts": { "github": { "tokens": { "GitHub.com": "ghp" } } },
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
                "easDeviceHosts": [{ "kind": "eas", "id": "h", "label": "H", "accessToken": SECRET_REDACTED }],
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
    /// tokens, never as the marker: GitHub sends the stored token,
    /// and a marker whose file is gone reads as no token, so the
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
                },
            })
            .to_string(),
        )
        .unwrap();
        // `sourceControlHostSecretName`: kind, field and host, base64url.
        conn_support::secret_store::write(
            &dir.join("secrets"),
            "source-control-Z2l0aHVi-dG9rZW5z-Z2l0aHViLmNvbQ",
            b"ghp-stored",
        )
        .unwrap();
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
            settings
                .host("github")
                .keyed_secret("tokens", "ghe.example.com"),
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
        // The settings file cannot be replaced: a folder holds its temp file's name.
        let temp = format!("settings.tmp-{}", std::process::id());
        fs::create_dir(dir.join(&temp)).unwrap();
        fs::write(dir.join(&temp).join("x"), "").unwrap();
        let error = store
            .update(
                json!({ "cloudSpeechCredentials": { "openai": "new", "xai": "x" } }),
                None,
            )
            .unwrap_err();
        assert_eq!(error.operation, "write-file");
        assert!(!error.detail.contains("new"));
        assert_eq!(stored(&dir, "voice-cloud-openai").as_deref(), Some("old"));
        assert_eq!(stored(&dir, "voice-cloud-xai"), None);
        assert_eq!(store.raw()["cloudSpeechCredentials"]["openai"], "old");
        fs::remove_dir_all(dir).unwrap();
    }

    /// `migrateLegacySourceControlSettings`: the retired `github` and `bitbucket` objects move
    /// to `sourceControlHosts` with their stored secrets, and no client sees them again.
    #[test]
    fn legacy_source_control_settings_move_with_their_secrets() {
        let dir = temp_state();
        let ghe = conn_support::base64::url_encode(b"ghe.example.com");
        let secrets = dir.join("secrets");
        conn_support::secret_store::ensure_dir(&secrets).unwrap();
        conn_support::secret_store::write(&secrets, &format!("github-token-{ghe}"), b"old")
            .unwrap();
        conn_support::secret_store::write(&secrets, "bitbucket-access-token", b"bb").unwrap();
        let file = json!({
            "github": { "tokens": { "github.com": "ghp", "ghe.example.com": SECRET_REDACTED } },
            "bitbucket": { "accessToken": SECRET_REDACTED, "apiToken": "bbapi" },
        });
        fs::write(dir.join("settings.json"), file.to_string()).unwrap();
        let store = SettingsStore::open(dir.join("settings.json"));
        let client = store.for_client();
        assert!(client.get("github").is_none(), "{client}");
        assert!(client.get("bitbucket").is_none(), "{client}");
        assert!(!client.to_string().contains("ghp"), "{client}");
        assert_eq!(
            client["sourceControlHosts"]["github"]["tokens"],
            json!({ "github.com": SECRET_REDACTED, "ghe.example.com": SECRET_REDACTED })
        );
        assert_eq!(
            store.raw()["sourceControlHosts"]["github"]["tokens"],
            json!({ "github.com": "ghp", "ghe.example.com": "old" })
        );
        let disk = on_disk(&dir);
        assert!(
            disk.get("github").is_none() && disk.get("bitbucket").is_none(),
            "{disk}"
        );
        assert_eq!(
            disk["sourceControlHosts"]["bitbucket"]["accessToken"],
            SECRET_REDACTED
        );
        // An inline legacy Bitbucket token moves to the store too.
        assert_eq!(
            disk["sourceControlHosts"]["bitbucket"]["apiToken"],
            SECRET_REDACTED
        );
        assert!(!disk.to_string().contains("bbapi"), "{disk}");
        assert_eq!(
            stored(&dir, "source-control-Yml0YnVja2V0-YXBpVG9rZW4").as_deref(),
            Some("bbapi")
        );
        assert_eq!(
            stored(&dir, &format!("source-control-Z2l0aHVi-dG9rZW5z-{ghe}")).as_deref(),
            Some("old")
        );
        assert_eq!(
            stored(&dir, "source-control-Yml0YnVja2V0-YWNjZXNzVG9rZW4").as_deref(),
            Some("bb")
        );
        assert_eq!(stored(&dir, &format!("github-token-{ghe}")), None);
        assert_eq!(stored(&dir, "bitbucket-access-token"), None);
        fs::remove_dir_all(dir).unwrap();
    }

    /// `foldLegacyProjectSettings`: a legacy per-project map moves into
    /// `projectSettingsOverrides` on load, so an unrelated save keeps it.
    #[test]
    fn an_unrelated_save_keeps_legacy_project_overrides() {
        let dir = temp_state();
        let file = json!({
            "projectAutoPullOverrides": { "p1": true, "p2": true },
            "projectSettingsOverrides": { "p2": { "defaultAutoPull": false } },
        });
        fs::write(dir.join("settings.json"), file.to_string()).unwrap();
        let store = SettingsStore::open(dir.join("settings.json"));
        store
            .update(json!({ "linkedEnvironmentsEnabled": true }), None)
            .unwrap();
        let disk = on_disk(&dir);
        assert_eq!(
            disk["projectSettingsOverrides"],
            json!({ "p1": { "defaultAutoPull": true }, "p2": { "defaultAutoPull": false } })
        );
        assert_eq!(
            disk["projectAutoPullOverrides"],
            json!({ "p1": true, "p2": false })
        );
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
        assert_eq!(SettingsStore::open(path).raw(), store.raw());
        fs::remove_dir_all(dir).unwrap();
    }

    /// `serverSettings.test.ts`, "leaves settings.json with $label untouched and disables
    /// destructive defaults": a file that does not decode gives T3's conservative defaults,
    /// stays byte for byte, and refuses saves until the user repairs it.
    #[test]
    fn an_undecodable_file_gives_safe_defaults_and_stays_untouched() {
        for broken in [
            "{\"defaultAutoPull\": tru",
            "{\"responseStreamingMode\":\"typo\"}",
            "{\"usageHistoryRetentionDays\": 0}",
            // T3 decodes the legacy fields apart; a wrong shape there is a broken file too.
            "{\"providers\":false}",
            // An optional key holds no explicit null, and the migration must not run.
            "{\"providers\":{},\"responseStreamingMode\":null}",
            // T3's persisted schema takes no null here either, though no client sends them.
            "{\"projectSettingsFolded\":null}",
            "{\"providerInstances\":{\"claudeAgent\":{\"driver\":\"claudeAgent\",\"enabled\":null}}}",
            // Past `Number.MAX_SAFE_INTEGER`.
            "{\"usageHistoryRetentionDays\":9007199254740992}",
        ] {
            let dir = temp_state();
            let path = dir.join("settings.json");
            fs::write(&path, broken).unwrap();
            let store = SettingsStore::open(path.clone());
            assert_eq!(
                fs::read_to_string(&path).unwrap(),
                broken,
                "opened: {broken}"
            );
            let view = store.for_client();
            conn_contract::from_json::<ServerSettings>(view.clone()).unwrap();
            assert_eq!(view["continueThreadsAfterServerUpdate"], false, "{broken}");
            assert_eq!(view["usageHistoryRetentionDays"], "unlimited", "{broken}");
            let error = store
                .update(json!({ "defaultAutoPull": true }), None)
                .unwrap_err();
            assert_eq!(error.operation, "read-file", "{broken}");
            assert_eq!(fs::read_to_string(&path).unwrap(), broken);
            // Opening it again writes nothing either.
            drop(SettingsStore::open(path.clone()));
            assert_eq!(fs::read_to_string(&path).unwrap(), broken, "{broken}");
            // Repaired by hand, the next save reads the user's value and keeps it.
            fs::write(&path, "{\"responseStreamingMode\":\"turn\"}").unwrap();
            let view = store
                .update(json!({ "defaultAutoPull": true }), None)
                .unwrap();
            assert_eq!(view["responseStreamingMode"], "turn");
            assert_eq!(
                SettingsStore::open(path).raw()["responseStreamingMode"],
                "turn"
            );
            fs::remove_dir_all(dir).unwrap();
        }
    }

    /// `serverSettings.test.ts`, "keeps an external settings edit": a save starts from the
    /// file, not from the copy this server read earlier.
    #[test]
    fn a_save_keeps_an_external_edit() {
        let dir = temp_state();
        let path = dir.join("settings.json");
        let store = SettingsStore::open(path.clone());
        store
            .update(json!({ "defaultAutoPull": true }), None)
            .unwrap();
        // An editor saves by rename.
        let mut edited = on_disk(&dir);
        edited["responseStreamingMode"] = json!("turn");
        fs::write(dir.join("settings.json.new"), edited.to_string()).unwrap();
        fs::rename(dir.join("settings.json.new"), &path).unwrap();
        let view = store
            .update(json!({ "worktreesDirectory": "/managed" }), None)
            .unwrap();
        assert_eq!(view["responseStreamingMode"], "turn");
        store
            .update(json!({ "enableAgentBrowserAccess": false }), None)
            .unwrap();
        let reopened = Value::Object(SettingsStore::open(path).raw());
        assert_eq!(reopened["responseStreamingMode"], "turn");
        assert_eq!(reopened["worktreesDirectory"], "/managed");
        assert_eq!(reopened["defaultAutoPull"], true);
        assert_eq!(reopened["enableAgentBrowserAccess"], false);
        fs::remove_dir_all(dir).unwrap();
    }

    /// `serverSettings.test.ts`, "saves through a symlinked settings": the link stays and its
    /// target gets the save, for a relative and an absolute link.
    #[cfg(unix)]
    #[test]
    fn saves_write_through_a_symlinked_file() {
        for relative in [true, false] {
            let dir = temp_state();
            let dotfiles = dir.join("dotfiles");
            fs::create_dir_all(&dotfiles).unwrap();
            let target = dotfiles.join("t3-settings.json");
            fs::write(&target, "{}").unwrap();
            let path = dir.join("settings.json");
            let link = if relative {
                PathBuf::from("dotfiles/t3-settings.json")
            } else {
                target.clone()
            };
            std::os::unix::fs::symlink(&link, &path).unwrap();
            let store = SettingsStore::open(path.clone());
            store
                .update(json!({ "responseStreamingMode": "paragraph" }), None)
                .unwrap();
            store
                .update(json!({ "responseStreamingMode": "turn" }), None)
                .unwrap();
            assert!(fs::symlink_metadata(&path).unwrap().is_symlink());
            assert_eq!(fs::read_link(&path).unwrap(), link);
            let saved: Value = serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
            assert_eq!(saved["responseStreamingMode"], "turn");
            assert_eq!(
                SettingsStore::open(path).raw()["responseStreamingMode"],
                "turn"
            );
            fs::remove_dir_all(dir).unwrap();
        }
    }

    /// Opening a legacy file rewrites it whole: the source control hosts this server does not
    /// serve stay on disk, though the server's own view leaves them out.
    #[test]
    fn the_legacy_migration_keeps_hosts_this_server_does_not_serve() {
        let dir = temp_state();
        let path = dir.join("settings.json");
        let bitbucket = json!({"email": "me@example.com", "workspace": "team"});
        fs::write(
            &path,
            json!({ "providers": {}, "sourceControlHosts": { "bitbucket": bitbucket } })
                .to_string(),
        )
        .unwrap();
        for _ in 0..2 {
            let store = SettingsStore::open(path.clone());
            assert!(
                store
                    .raw()
                    .get("sourceControlHosts")
                    .and_then(|h| h.get("bitbucket"))
                    .is_none()
            );
            let file = on_disk(&dir);
            assert!(file.get("providers").is_none(), "migrated");
            assert_eq!(file["sourceControlHosts"]["bitbucket"], bitbucket);
        }
        // An unrelated save keeps it too, across a reopen.
        let store = SettingsStore::open(path.clone());
        store
            .update(json!({ "worktreesDirectory": "/managed" }), None)
            .unwrap();
        drop(SettingsStore::open(path));
        let file = on_disk(&dir);
        assert_eq!(file["sourceControlHosts"]["bitbucket"], bitbucket);
        assert_eq!(file["worktreesDirectory"], "/managed");
        fs::remove_dir_all(dir).unwrap();
    }

    /// `serverSettings.test.ts`, "migrates saved token delivery to paragraph buffering without
    /// resetting settings", with T3's lenient JSON (`fromLenientJson`): a T3 file with comments,
    /// trailing commas and the retired `token` mode loads, keeps its other preferences, and
    /// takes an unrelated save.
    #[test]
    fn a_t3_file_with_comments_and_the_retired_token_mode_loads_and_saves() {
        let dir = temp_state();
        let path = dir.join("settings.json");
        fs::write(
            &path,
            "{\n  // written by T3\n  \"responseStreamingMode\": \"token\",\n  \"defaultAutoPull\": true, /* kept */\n  \"worktreeCleanup\": null,\n  \"projectSettingsOverrides\": { \"p\": { \"responseStreamingMode\": \"token\", }, },\n}\n",
        )
        .unwrap();
        let store = SettingsStore::open(path.clone());
        let view = store.for_client();
        assert_eq!(view["responseStreamingMode"], "paragraph");
        assert_eq!(
            view["projectSettingsOverrides"]["p"]["responseStreamingMode"],
            "paragraph"
        );
        assert_eq!(view["defaultAutoPull"], true);
        store
            .update(json!({ "enableAgentBrowserAccess": false }), None)
            .unwrap();
        let reopened = Value::Object(SettingsStore::open(path).raw());
        assert_eq!(reopened["defaultAutoPull"], true);
        assert_eq!(reopened["enableAgentBrowserAccess"], false);
        assert_eq!(reopened["responseStreamingMode"], "paragraph");
        fs::remove_dir_all(dir).unwrap();
    }

    /// `serverSettings.test.ts`, "enables previously used optional providers while migrating
    /// legacy settings": T3's history in `statev2.sqlite` turns on a driver that ran, unless
    /// the legacy map turns it off.
    #[test]
    fn the_legacy_migration_turns_on_providers_t3_ran() {
        let history = |dir: &Path| {
            let db = rusqlite::Connection::open(dir.join("statev2.sqlite")).unwrap();
            db.execute_batch(
                "CREATE TABLE projection_thread_sessions (provider_name TEXT, provider_instance_id TEXT);
                 CREATE TABLE provider_session_runtime (provider_name TEXT, provider_instance_id TEXT);
                 INSERT INTO projection_thread_sessions VALUES ('grok', NULL);
                 INSERT INTO provider_session_runtime VALUES ('opencode', 'opencode');",
            )
            .unwrap();
        };
        let dir = temp_state();
        history(&dir);
        let path = dir.join("settings.json");
        fs::write(
            &path,
            json!({ "providers": { "opencode": { "enabled": false } } }).to_string(),
        )
        .unwrap();
        for _ in 0..2 {
            let raw = SettingsStore::open(path.clone()).raw();
            assert!(provider_instance_enabled(&raw, None, "grok"));
            assert!(
                !provider_instance_enabled(&raw, None, "opencode"),
                "explicitly off"
            );
            assert!(
                !provider_instance_enabled(&raw, None, "cursor"),
                "never ran"
            );
            assert_eq!(
                on_disk(&dir)["providerInstances"]["grok"],
                json!({ "driver": "grok", "enabled": true, "config": {} })
            );
        }
        fs::remove_dir_all(dir).unwrap();
    }

    /// `serverSettings.test.ts`, "moves customized legacy provider settings": T3's
    /// `providers` map becomes provider instances at load, and an explicit instance wins.
    #[test]
    fn legacy_provider_settings_become_instances() {
        let dir = temp_state();
        let path = dir.join("settings.json");
        fs::write(
            &path,
            json!({ "providers": {
                "claudeAgent": { "enabled": false },
                "codex": { "binaryPath": "/opt/codex" },
                "grok": {},
                "bad slug": { "enabled": false },
            } })
            .to_string(),
        )
        .unwrap();
        for _ in 0..2 {
            let store = SettingsStore::open(path.clone());
            let raw = store.raw();
            assert!(!provider_instance_enabled(&raw, None, "claudeAgent"));
            assert!(provider_instance_enabled(&raw, None, "codex"));
            assert!(!provider_instance_enabled(&raw, None, "grok"));
            assert_eq!(
                raw["providerInstances"],
                json!({
                    "claudeAgent": { "driver": "claudeAgent", "enabled": false, "config": {} },
                    "codex": { "driver": "codex", "config": { "binaryPath": "/opt/codex" } },
                })
            );
            conn_contract::from_json::<ServerSettings>(store.for_client()).unwrap();
            assert!(on_disk(&dir).get("providers").is_none(), "migrated once");
        }
        // An explicit instance beats the legacy map, across restarts.
        fs::write(
            &path,
            json!({
                "providers": { "claudeAgent": { "enabled": false } },
                "providerInstances": { "claudeAgent": { "driver": "claudeAgent", "enabled": true } },
            })
            .to_string(),
        )
        .unwrap();
        for _ in 0..2 {
            let raw = SettingsStore::open(path.clone()).raw();
            assert!(provider_instance_enabled(&raw, None, "claudeAgent"));
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn response_streaming_mode_follows_the_project_override() {
        use conn_engine::ResponseStreamingMode::{Paragraph, Turn};
        let empty = Map::new();
        assert_eq!(response_streaming_mode(&empty, Some("p")), Paragraph);
        let Value::Object(turn) = serde_json::json!({
            "responseStreamingMode": "turn",
            "projectSettingsOverrides": {"q": {"responseStreamingMode": "paragraph"}},
        }) else {
            panic!()
        };
        assert_eq!(response_streaming_mode(&turn, None), Turn);
        assert_eq!(response_streaming_mode(&turn, Some("p")), Turn);
        assert_eq!(response_streaming_mode(&turn, Some("q")), Paragraph);
    }

    /// `serverSettings.ts` (`read-provider-history`): a history that cannot be read fails
    /// the load instead of migrating without it. The opt-out still holds and the file stays
    /// for the next load, which migrates once the history reads.
    #[test]
    fn an_unreadable_provider_history_keeps_the_legacy_file() {
        let dir = temp_state();
        let path = dir.join("settings.json");
        let legacy = json!({ "providers": { "claudeAgent": { "enabled": false } } }).to_string();
        fs::write(&path, &legacy).unwrap();
        // A T3 database whose history tables cannot be read.
        rusqlite::Connection::open(dir.join("statev2.sqlite"))
            .unwrap()
            .execute_batch("CREATE TABLE other (x)")
            .unwrap();
        let store = SettingsStore::open(path.clone());
        assert!(!provider_instance_enabled(
            &store.raw(),
            None,
            "claudeAgent"
        ));
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            legacy,
            "kept for a retry"
        );
        rusqlite::Connection::open(dir.join("statev2.sqlite"))
            .unwrap()
            .execute_batch(
                "CREATE TABLE projection_thread_sessions (provider_name TEXT, provider_instance_id TEXT);
                 CREATE TABLE provider_session_runtime (provider_name TEXT, provider_instance_id TEXT);",
            )
            .unwrap();
        let store = SettingsStore::open(path);
        assert!(!provider_instance_enabled(
            &store.raw(),
            None,
            "claudeAgent"
        ));
        assert!(on_disk(&dir).get("providers").is_none(), "migrated");
        fs::remove_dir_all(dir).unwrap();
    }

    /// Only a missing T3 database means no history: one that cannot even be opened (here a
    /// folder in its place) fails the load like an unreadable one, and the file stays.
    #[test]
    fn an_inaccessible_provider_history_keeps_the_legacy_file() {
        let dir = temp_state();
        let path = dir.join("settings.json");
        let legacy = json!({ "providers": { "claudeAgent": { "enabled": false } } }).to_string();
        fs::write(&path, &legacy).unwrap();
        fs::create_dir(dir.join("statev2.sqlite")).unwrap();
        let store = SettingsStore::open(path.clone());
        assert!(!provider_instance_enabled(
            &store.raw(),
            None,
            "claudeAgent"
        ));
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            legacy,
            "kept for a retry"
        );
        assert!(store.needs_reload());
        fs::remove_dir(dir.join("statev2.sqlite")).unwrap();
        store.reload_if_failed();
        assert!(!store.needs_reload());
        assert!(!provider_instance_enabled(
            &store.raw(),
            None,
            "claudeAgent"
        ));
        assert!(on_disk(&dir).get("providers").is_none(), "migrated");
        fs::remove_dir_all(dir).unwrap();
    }

    /// A saved whole number written as a float is one to T3; one past the safe range is
    /// refused and the file stays as it was.
    #[test]
    fn saved_numbers_follow_t3() {
        let dir = temp_state();
        let path = dir.join("settings.json");
        let store = SettingsStore::open(path.clone());
        store
            .update(json!({ "usageHistoryRetentionDays": 30.0 }), None)
            .unwrap();
        assert_eq!(on_disk(&dir)["usageHistoryRetentionDays"], 30);
        let before = fs::read_to_string(&path).unwrap();
        let error = store
            .update(
                json!({ "usageHistoryRetentionDays": 9_007_199_254_740_992_u64 }),
                None,
            )
            .unwrap_err();
        assert_eq!(error.operation, "normalize");
        assert_eq!(fs::read_to_string(&path).unwrap(), before);
        fs::remove_dir_all(dir).unwrap();
    }

    /// A link to a missing T3 database is not "no database": the load fails and the legacy
    /// file stays. The history is read once for that load.
    #[cfg(unix)]
    #[test]
    fn a_dangling_history_link_keeps_the_legacy_file() {
        let dir = temp_state();
        let path = dir.join("settings.json");
        let legacy = json!({ "providers": { "claudeAgent": { "enabled": false } } }).to_string();
        fs::write(&path, &legacy).unwrap();
        std::os::unix::fs::symlink("gone.sqlite", dir.join("statev2.sqlite")).unwrap();
        file::HISTORY_READS.with(|reads| reads.set(0));
        let store = SettingsStore::open(path.clone());
        assert_eq!(
            file::HISTORY_READS.with(std::cell::Cell::get),
            1,
            "read once"
        );
        assert!(!provider_instance_enabled(
            &store.raw(),
            None,
            "claudeAgent"
        ));
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            legacy,
            "kept for a retry"
        );
        assert!(store.needs_reload());
        fs::remove_dir_all(dir).unwrap();
    }

    /// Retries that queue behind one writer load once between them.
    #[test]
    fn concurrent_retries_load_once() {
        use std::sync::Arc;
        let dir = temp_state();
        let path = dir.join("settings.json");
        fs::write(&path, json!({ "providers": {} }).to_string()).unwrap();
        fs::create_dir(dir.join("statev2.sqlite")).unwrap();
        let store = Arc::new(SettingsStore::open(path));
        assert!(store.needs_reload());
        fs::remove_dir(dir.join("statev2.sqlite")).unwrap();
        let writer = crate::lock(&store.writer);
        let retries: Vec<_> = (0..2)
            .map(|_| {
                let store = store.clone();
                std::thread::spawn(move || store.reload_if_failed())
            })
            .collect();
        // Both pass their first look and wait for the writer.
        std::thread::sleep(std::time::Duration::from_millis(200));
        drop(writer);
        for retry in retries {
            retry.join().unwrap();
        }
        assert_eq!(store.reloads.load(std::sync::atomic::Ordering::Relaxed), 1);
        assert!(!store.needs_reload());
        fs::remove_dir_all(dir).unwrap();
    }

    /// A save in progress never holds up a reader: the writer works outside the lock that
    /// readers on the runtime thread take, and publishes the result at the end.
    #[cfg(unix)]
    #[test]
    fn a_reader_is_not_held_up_by_a_save_in_progress() {
        use std::sync::{Arc, mpsc};
        let dir = temp_state();
        let path = dir.join("settings.json");
        let store = Arc::new(SettingsStore::open(path.clone()));
        // The save's reload blocks on a FIFO until the test writes to it.
        let status = std::process::Command::new("mkfifo")
            .arg(&path)
            .status()
            .unwrap();
        assert!(status.success());
        let writer = {
            let store = store.clone();
            std::thread::spawn(move || store.update(json!({ "defaultAutoPull": true }), None))
        };
        let (sent, read) = mpsc::channel();
        let reader = {
            let store = store.clone();
            std::thread::spawn(move || {
                // Give the writer time to reach the reload first.
                std::thread::sleep(std::time::Duration::from_millis(200));
                let _ = sent.send(store.raw());
            })
        };
        let answered = read.recv_timeout(std::time::Duration::from_secs(5)).is_ok();
        fs::write(&path, "{}").unwrap();
        reader.join().unwrap();
        writer.join().unwrap().unwrap();
        assert!(answered, "the reader waited for the save");
        assert_eq!(store.raw()["defaultAutoPull"], true);
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
