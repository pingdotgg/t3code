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
//! merge, with the replacements and entry maps listed in [`apply_patch`]. Secrets stay in the
//! file (0600) instead of a secret store and are redacted for clients; the TypeScript server
//! moves inline secrets into its store when it next starts.

use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde_json::{Map, Value, json};
use tokio::sync::watch;

use crate::auth::write_private;

/// What `redactServerSettingsForClient` shows instead of a saved secret.
pub const SECRET_REDACTED: &str = "\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}";

/// Settings fields that hold a secret (`secretSetting` in contracts and provider packages).
const SECRET_FIELDS: &[&str] = &[
    "apiKey",
    "managementKey",
    "serverPassword",
    "accessToken",
    "agentToken",
];
/// Secret maps keyed by host (`sourceControlHosts.*.tokens`, `signIns`).
const SECRET_MAPS: &[&str] = &["tokens", "signIns"];

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
/// Legacy per-project maps the TypeScript server folds into `projectSettingsOverrides`.
const LEGACY_PROJECT_MAPS: &[(&str, &str)] = &[
    ("projectAgentBrowserAccessOverrides", "agentBrowserAccess"),
    ("projectAutoPullOverrides", "autoPull"),
    ("projectScriptOverrides", "scripts"),
];

#[derive(Debug)]
pub struct SettingsError {
    pub settings_path: String,
    pub operation: &'static str,
    pub detail: String,
}

impl SettingsError {
    /// `ServerSettingsError` as the contract encodes it.
    pub fn to_contract(&self) -> Value {
        json!({
            "_tag": "ServerSettingsError",
            "settingsPath": self.settings_path,
            "operation": self.operation,
            "detail": self.detail,
        })
    }
}

pub struct SettingsStore {
    path: PathBuf,
    sparse: Mutex<Map<String, Value>>,
    /// Bumped after each write; `subscribeServerConfig` sends `settingsUpdated` on it.
    revision: watch::Sender<u64>,
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
        let mut settings = Value::Object(self.raw());
        redact(&mut settings);
        settings
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.revision.subscribe()
    }

    /// Applies a `server.updateSettings` patch, saves, and returns the client view.
    pub fn update(&self, patch: Value, mutation: Option<Value>) -> Result<Value, SettingsError> {
        let Value::Object(patch) = patch else {
            return Err(self.error("normalize", "the patch is not an object"));
        };
        let mut sparse = self.lock();
        let mut next = sparse.clone();
        apply_patch(&mut next, patch);
        if let Some(mutation) = mutation {
            apply_provider_instance_mutation(&mut next, mutation)
                .map_err(|detail| self.error("normalize", detail))?;
        }
        let mut bytes = serde_json::to_vec(&next).expect("settings serialize");
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
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Map<String, Value>> {
        self.sparse
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
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
            // An entry keeps stored provider instances the patch does not name.
            let stored = entries
                .get(&id)
                .and_then(|e| e.get("providerInstances"))
                .cloned();
            let mut value = value;
            if let (Some(stored), Some(entry)) = (stored, value.as_object_mut())
                && !entry.contains_key("providerInstances")
            {
                entry.insert("providerInstances".into(), stored);
            }
            entries.insert(id, value);
        } else {
            entries.insert(id, value);
        }
    }
}

/// `applyServerSettingsPatch`, for the fields clients send.
pub fn apply_patch(settings: &mut Map<String, Value>, mut patch: Map<String, Value>) {
    // Legacy per-project maps become `projectSettingsOverrides` entries.
    for (legacy, field) in LEGACY_PROJECT_MAPS {
        let Some(Value::Object(map)) = patch.remove(*legacy) else {
            continue;
        };
        let overrides = patch
            .entry("projectSettingsOverrides")
            .or_insert_with(|| Value::Object(Map::new()));
        let Some(overrides) = overrides.as_object_mut() else {
            continue;
        };
        for (project, value) in map {
            let entry = overrides.entry(project.clone()).or_insert_with(|| {
                settings
                    .get("projectSettingsOverrides")
                    .and_then(|o| o.get(&project))
                    .cloned()
                    .unwrap_or_else(|| json!({}))
            });
            if let Some(entry) = entry.as_object_mut() {
                if value.is_null() {
                    entry.remove(*field);
                } else {
                    entry.insert((*field).into(), value);
                }
            }
        }
    }

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
            let mut config = mutation
                .get("instance")
                .cloned()
                .ok_or("the mutation carries no instance")?;
            keep_echoed_secrets(instances.get(&id), &mut config);
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

/// A client shown `••••••` or a redacted environment value sends it back unchanged; keep the
/// saved secret instead of storing the marker.
fn keep_echoed_secrets(saved: Option<&Value>, next: &mut Value) {
    let Some(saved) = saved else {
        return;
    };
    if let (Some(Value::Array(saved_env)), Some(Value::Array(env))) =
        (saved.get("environment"), next.get_mut("environment"))
    {
        for variable in env.iter_mut() {
            let redacted = variable["valueRedacted"] == true && variable["value"] == "";
            if redacted && let Some(old) = saved_env.iter().find(|v| v["name"] == variable["name"])
            {
                variable["value"] = old["value"].clone();
                if let Some(object) = variable.as_object_mut() {
                    object.remove("valueRedacted");
                }
            }
        }
    }
    restore_markers(saved, next);
}

fn restore_markers(saved: &Value, next: &mut Value) {
    let Some(next) = next.as_object_mut() else {
        return;
    };
    for (key, value) in next.iter_mut() {
        if value == SECRET_REDACTED {
            if let Some(old) = saved.get(key) {
                *value = old.clone();
            }
        } else if value.is_object()
            && let Some(old) = saved.get(key)
        {
            restore_markers(old, value);
        }
    }
}

/// Hides saved secrets: secret fields show `••••••`, sensitive environment values show empty
/// with `valueRedacted`.
fn redact(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, field) in map.iter_mut() {
                if SECRET_FIELDS.contains(&key.as_str()) {
                    if field.as_str().is_some_and(|s| !s.is_empty()) {
                        *field = Value::String(SECRET_REDACTED.into());
                    }
                } else if SECRET_MAPS.contains(&key.as_str()) && field.is_object() {
                    for secret in ensure_object(field).values_mut() {
                        if secret.as_str().is_some_and(|s| !s.is_empty()) {
                            *secret = Value::String(SECRET_REDACTED.into());
                        }
                    }
                } else if key == "environment"
                    && let Value::Array(variables) = field
                {
                    for variable in variables {
                        let hide = variable["sensitive"] == true && variable["value"] != "";
                        if hide && let Some(object) = variable.as_object_mut() {
                            object.insert("value".into(), Value::String(String::new()));
                            object.insert("valueRedacted".into(), Value::Bool(true));
                        }
                    }
                } else {
                    redact(field);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(redact),
        _ => {}
    }
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
                "enableAssistantStreaming": false,
            }),
        );
        assert_eq!(
            next,
            json!({
                "linkedEnvironmentsEnabled": true,
                "storageCleanup": { "worktreeAfterDays": 5, "worktreeOnMerge": true },
                "defaultModelSelection": { "instanceId": "claudeAgent", "model": "b" },
                "enableAssistantStreaming": false,
            })
        );
    }

    #[test]
    fn entry_maps_set_and_remove_whole_entries() {
        let next = patched(
            json!({ "textGenerators": { "a": { "kind": "x", "url": "1" }, "b": { "kind": "y" } } }),
            json!({ "textGenerators": { "a": { "kind": "x" }, "b": null, "c": { "kind": "z" } } }),
        );
        assert_eq!(
            next,
            json!({ "textGenerators": { "a": { "kind": "x" }, "c": { "kind": "z" } } })
        );
    }

    #[test]
    fn legacy_project_maps_become_project_overrides() {
        let next = patched(
            json!({ "projectSettingsOverrides": { "p1": { "autoPull": true, "providerInstances": { "k": 1 } } } }),
            json!({ "projectScriptOverrides": { "p1": [] }, "projectAutoPullOverrides": { "p1": null } }),
        );
        assert_eq!(
            next,
            json!({ "projectSettingsOverrides": { "p1": { "scripts": [], "providerInstances": { "k": 1 } } } })
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

    #[test]
    fn secrets_are_redacted_for_clients_and_kept_when_echoed() {
        let mut view = json!({
            "providerInstances": { "oc": { "driver": "opencode", "config": { "serverPassword": "pw" },
                "environment": [{ "name": "KEY", "value": "s3cret", "sensitive": true }, { "name": "MODE", "value": "x", "sensitive": false }] } },
            "sourceControlHosts": { "github": { "tokens": { "github.com": "ghp" } } },
        });
        redact(&mut view);
        let instance = &view["providerInstances"]["oc"];
        assert_eq!(instance["config"]["serverPassword"], SECRET_REDACTED);
        assert_eq!(
            instance["environment"][0],
            json!({ "name": "KEY", "value": "", "sensitive": true, "valueRedacted": true })
        );
        assert_eq!(instance["environment"][1]["value"], "x");
        assert_eq!(
            view["sourceControlHosts"]["github"]["tokens"]["github.com"],
            SECRET_REDACTED
        );

        let mut settings = Map::new();
        apply_patch(
            &mut settings,
            json!({ "providerInstances": { "oc": { "driver": "opencode", "config": { "serverPassword": "pw" },
                "environment": [{ "name": "KEY", "value": "s3cret", "sensitive": true }] } } })
                .as_object()
                .unwrap()
                .clone(),
        );
        // The client edits the display name and sends the redacted view back.
        let mut echoed = view["providerInstances"]["oc"].clone();
        echoed["displayName"] = json!("OpenCode");
        apply_provider_instance_mutation(
            &mut settings,
            json!({ "operation": "upsert", "instanceId": "oc", "instance": echoed }),
        )
        .unwrap();
        let saved = &settings["providerInstances"]["oc"];
        assert_eq!(saved["config"]["serverPassword"], "pw");
        assert_eq!(saved["environment"][0]["value"], "s3cret");
        assert_eq!(saved["displayName"], "OpenCode");
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
        let mut view =
            json!({ "providerInstances": { "x": { "environment": ["KEY", 3] } }, "tokens": 5 });
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
            .update(json!({ "enableAssistantStreaming": false }), None)
            .unwrap();
        assert_eq!(view["linkedEnvironmentsEnabled"], true);
        assert!(revision.has_changed().unwrap());
        revision.mark_unchanged();
        let saved: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            saved,
            json!({ "linkedEnvironmentsEnabled": true, "enableAssistantStreaming": false })
        );
        assert_eq!(SettingsStore::open(path.clone()).raw(), store.raw());
        // A malformed file means defaults, and is left alone until a write.
        fs::write(&path, "{nope").unwrap();
        assert!(SettingsStore::open(path).raw().is_empty());
        fs::remove_dir_all(dir).unwrap();
    }
}
