//! Model preferences an environment keeps for every client: favorites, and per provider
//! instance the models hidden from the picker and their order (`providerModelPreferences`,
//! `favorites` in `contracts/src/settings.ts`; `ProviderModelsSection.tsx`, `modelOrdering.ts`,
//! `modelSelection.ts`).
//!
//! Pure and GPUI-free. Writes are `server.updateSettings` patches with `setModelsHidden`,
//! `setModelFavorites` or `setProviderModelOrder`, so two clients changing one model never
//! undo each other's other changes.

use std::collections::{BTreeMap, HashMap, HashSet};

use conn_contract::{ServerSettings, ServerSettingsProviderInstancesValue as InstanceConfig};
use serde_json::{Value, json};

/// The longest custom model slug (`MAX_CUSTOM_MODEL_LENGTH`).
pub const MAX_CUSTOM_MODEL_LENGTH: usize = 256;

/// The Models list shows a filter above this many models (`FILTER_THRESHOLD`).
pub const MODEL_FILTER_THRESHOLD: usize = 8;

/// One instance's hidden models and order (`ProviderModelPreferences[instanceId]`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InstanceModelPreferences {
    pub hidden_models: Vec<String>,
    pub model_order: Vec<String>,
}

/// Every model preference of one environment.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ModelPreferences {
    /// `(instance id, model slug)` in the order the server keeps them.
    pub favorites: Vec<(String, String)>,
    pub instances: BTreeMap<String, InstanceModelPreferences>,
}

impl ModelPreferences {
    /// The preferences in `settings`. `null` (never migrated) reads as none.
    #[must_use]
    pub fn from_settings(settings: &ServerSettings) -> Self {
        let favorites = settings
            .favorites
            .clone()
            .flatten()
            .unwrap_or_default()
            .into_iter()
            .map(|favorite| (favorite.provider, favorite.model))
            .collect();
        let instances = settings
            .provider_model_preferences
            .clone()
            .flatten()
            .unwrap_or_default()
            .into_iter()
            .map(|(id, value)| {
                (
                    id,
                    InstanceModelPreferences {
                        hidden_models: value.hidden_models.unwrap_or_default(),
                        model_order: value.model_order.unwrap_or_default(),
                    },
                )
            })
            .collect();
        Self {
            favorites,
            instances,
        }
    }

    /// One instance's preferences, or none.
    #[must_use]
    pub fn instance(&self, instance_id: &str) -> InstanceModelPreferences {
        self.instances.get(instance_id).cloned().unwrap_or_default()
    }

    /// Whether `slug` of `instance_id` is hidden from the picker.
    #[must_use]
    pub fn is_hidden(&self, instance_id: &str, slug: &str) -> bool {
        self.instances
            .get(instance_id)
            .is_some_and(|prefs| prefs.hidden_models.iter().any(|m| m == slug))
    }

    /// Whether `slug` of `instance_id` is a favorite.
    #[must_use]
    pub fn is_favorite(&self, instance_id: &str, slug: &str) -> bool {
        self.favorites
            .iter()
            .any(|(provider, model)| provider == instance_id && model == slug)
    }

    /// The favorite slugs of one instance, in favorite order.
    #[must_use]
    pub fn favorite_models(&self, instance_id: &str) -> Vec<String> {
        self.favorites
            .iter()
            .filter(|(provider, _)| provider == instance_id)
            .map(|(_, model)| model.clone())
            .collect()
    }
}

/// `sortModelsForProviderInstance`: favorites first when `group_favorites`, then the saved
/// order, then the order the provider reports. The sort is stable.
#[must_use]
pub fn sort_models_for_instance<T>(
    models: Vec<T>,
    slug: impl Fn(&T) -> &str,
    model_order: &[String],
    favorites: &HashSet<&str>,
    group_favorites: bool,
) -> Vec<T> {
    let rank: HashMap<&str, usize> = model_order
        .iter()
        .enumerate()
        .map(|(index, slug)| (slug.as_str(), index))
        .collect();
    let mut indexed: Vec<(usize, T)> = models.into_iter().enumerate().collect();
    indexed.sort_by_key(|(original, model)| {
        let key = slug(model);
        let favorite_rank = usize::from(!(group_favorites && favorites.contains(key)));
        (
            favorite_rank,
            rank.get(key).copied().unwrap_or(usize::MAX),
            *original,
        )
    });
    indexed.into_iter().map(|(_, model)| model).collect()
}

/// Where a model sits in the Models list (`groupOf`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelGroup {
    Favorite,
    Visible,
    /// Hidden from the picker. Custom models are never hidden.
    Hidden,
}

/// One row of an instance's Models list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelRow {
    pub slug: String,
    pub name: String,
    pub is_custom: bool,
    pub group: ModelGroup,
    /// `Fast mode`, `No reasoning` (`describeModelCapabilities`).
    pub capability_labels: Vec<&'static str>,
}

/// What a model of the Models list is, before grouping.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelEntry {
    pub slug: String,
    pub name: String,
    pub is_custom: bool,
    pub capability_labels: Vec<&'static str>,
}

/// `groupModelsForDisplay`: favorites, then the visible models, then the hidden ones, each in
/// the saved order. A favorite the provider no longer reports keeps a row, or its star could
/// never be cleared.
#[must_use]
pub fn group_models_for_display(
    models: &[ModelEntry],
    prefs: &InstanceModelPreferences,
    favorite_models: &[String],
) -> Vec<ModelRow> {
    let reported: HashSet<&str> = models.iter().map(|m| m.slug.as_str()).collect();
    let mut all: Vec<ModelEntry> = models.to_vec();
    for slug in favorite_models {
        if !reported.contains(slug.as_str()) {
            all.push(ModelEntry {
                slug: slug.clone(),
                name: slug.clone(),
                is_custom: false,
                capability_labels: Vec::new(),
            });
        }
    }
    let favorites: HashSet<&str> = favorite_models.iter().map(String::as_str).collect();
    let hidden: HashSet<&str> = prefs.hidden_models.iter().map(String::as_str).collect();
    let ordered = sort_models_for_instance(
        all,
        |m| m.slug.as_str(),
        &prefs.model_order,
        &favorites,
        true,
    );
    let group_of = |m: &ModelEntry| {
        if favorites.contains(m.slug.as_str()) {
            ModelGroup::Favorite
        } else if !m.is_custom && hidden.contains(m.slug.as_str()) {
            ModelGroup::Hidden
        } else {
            ModelGroup::Visible
        }
    };
    let mut rows: Vec<ModelRow> = ordered
        .into_iter()
        .map(|m| ModelRow {
            group: group_of(&m),
            slug: m.slug,
            name: m.name,
            is_custom: m.is_custom,
            capability_labels: m.capability_labels,
        })
        .collect();
    rows.sort_by_key(|row| match row.group {
        ModelGroup::Favorite => 0,
        ModelGroup::Visible => 1,
        ModelGroup::Hidden => 2,
    });
    rows
}

/// `nextHiddenModelsForBulkToggle`: shows every built-in model when all are hidden, else hides
/// them all. Returns the new hidden list and the models it changes.
#[must_use]
pub fn bulk_toggle_hidden(
    built_in_slugs: &[String],
    hidden_models: &[String],
) -> (Vec<String>, Vec<String>) {
    let all_hidden = built_in_slugs
        .iter()
        .all(|slug| hidden_models.contains(slug));
    let next = if all_hidden {
        hidden_models
            .iter()
            .filter(|slug| !built_in_slugs.contains(slug))
            .cloned()
            .collect()
    } else {
        let mut next = hidden_models.to_vec();
        for slug in built_in_slugs {
            if !next.contains(slug) {
                next.push(slug.clone());
            }
        }
        next
    };
    (next, built_in_slugs.to_vec())
}

/// `handleMove`: the new order after moving `slug` one row up (`-1`) or down (`1`) within its
/// group, or `None` when it cannot move.
#[must_use]
pub fn move_model(rows: &[ModelRow], slug: &str, direction: isize) -> Option<Vec<String>> {
    let index = rows.iter().position(|row| row.slug == slug)?;
    let next = index.checked_add_signed(direction)?;
    let neighbour = rows.get(next)?;
    if neighbour.group != rows[index].group {
        return None;
    }
    let mut order: Vec<String> = rows.iter().map(|row| row.slug.clone()).collect();
    order.swap(index, next);
    Some(order)
}

/// `server.updateSettings` payload for `setModelsHidden`.
#[must_use]
pub fn set_models_hidden_request(instance_id: &str, changes: &[(String, bool)]) -> Value {
    let items: Vec<Value> = changes
        .iter()
        .map(|(model, hidden)| json!({ "provider": instance_id, "model": model, "hidden": hidden }))
        .collect();
    json!({ "patch": { "setModelsHidden": items } })
}

/// `server.updateSettings` payload for `setModelFavorites`. It sends the wanted state, so two
/// clients adding a favorite do not cancel each other.
#[must_use]
pub fn set_model_favorites_request(instance_id: &str, changes: &[(String, bool)]) -> Value {
    let items: Vec<Value> = changes
        .iter()
        .map(|(model, favorite)| {
            json!({ "provider": instance_id, "model": model, "favorite": favorite })
        })
        .collect();
    json!({ "patch": { "setModelFavorites": items } })
}

/// `server.updateSettings` payload for `setProviderModelOrder`.
#[must_use]
pub fn set_model_order_request(instance_id: &str, model_order: &[String]) -> Value {
    json!({
        "patch": {
            "setProviderModelOrder": { "provider": instance_id, "modelOrder": model_order },
        },
    })
}

/// The slugs of `config.customModels`, in order (`readCustomModelEntries`). Entries may be a
/// slug or `{ slug, name, capabilities }`; duplicates and blanks are skipped.
#[must_use]
pub fn custom_models(instance: &InstanceConfig) -> Vec<(String, String)> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for entry in raw_custom_models(instance) {
        let (slug, name) = match &entry {
            Value::String(slug) => (slug.trim().to_owned(), None),
            Value::Object(map) => (
                map.get("slug")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_owned(),
                map.get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .map(str::to_owned),
            ),
            _ => continue,
        };
        if slug.is_empty() || !seen.insert(slug.clone()) {
            continue;
        }
        let name = name.unwrap_or_else(|| slug.clone());
        out.push((slug, name));
    }
    out
}

fn raw_custom_models(instance: &InstanceConfig) -> Vec<Value> {
    instance
        .config
        .as_ref()
        .and_then(|config| config.get("customModels"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn with_raw_custom_models(instance: &InstanceConfig, entries: Vec<Value>) -> InstanceConfig {
    let mut config = instance
        .config
        .as_ref()
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    config.insert("customModels".to_owned(), Value::Array(entries));
    InstanceConfig {
        config: Some(Value::Object(config)),
        ..instance.clone()
    }
}

/// Why a custom model cannot be added (`handleAdd`), or the slug to add.
///
/// # Errors
///
/// Returns the message Conn shows under the field.
pub fn validate_custom_model(
    input: &str,
    built_in_slugs: &[String],
    custom_slugs: &[String],
) -> Result<String, &'static str> {
    let slug = input.trim();
    if slug.is_empty() {
        return Err("Enter a model slug.");
    }
    if built_in_slugs.iter().any(|built_in| built_in == slug) {
        return Err("That model is already built in.");
    }
    if slug.chars().count() > MAX_CUSTOM_MODEL_LENGTH {
        return Err("Model slugs must be 256 characters or less.");
    }
    if custom_slugs.iter().any(|custom| custom == slug) {
        return Err("That custom model is already saved.");
    }
    Ok(slug.to_owned())
}

/// The instance with `slug` added to its custom models. Entries already saved stay as written.
#[must_use]
pub fn with_custom_model_added(instance: &InstanceConfig, slug: &str) -> InstanceConfig {
    let mut entries = raw_custom_models(instance);
    entries.push(json!(slug));
    with_raw_custom_models(instance, entries)
}

/// The instance without the custom model `slug`.
#[must_use]
pub fn with_custom_model_removed(instance: &InstanceConfig, slug: &str) -> InstanceConfig {
    let entries = raw_custom_models(instance)
        .into_iter()
        .filter(|entry| {
            let entry_slug = match entry {
                Value::String(s) => s.trim(),
                Value::Object(map) => map.get("slug").and_then(Value::as_str).unwrap_or_default(),
                _ => "",
            };
            entry_slug.trim() != slug
        })
        .collect();
    with_raw_custom_models(instance, entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(slug: &str, custom: bool) -> ModelEntry {
        ModelEntry {
            slug: slug.to_owned(),
            name: slug.to_owned(),
            is_custom: custom,
            capability_labels: Vec::new(),
        }
    }

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| (*v).to_owned()).collect()
    }

    #[test]
    fn preferences_read_the_settings_and_null_reads_as_none() {
        let settings: ServerSettings = serde_json::from_value(json!({
            "favorites": [{ "provider": "codex", "model": "a" }],
            "providerModelPreferences": { "codex": { "hiddenModels": ["b"], "modelOrder": ["c", "a"] } },
        }))
        .expect("settings");
        let prefs = ModelPreferences::from_settings(&settings);
        assert!(prefs.is_favorite("codex", "a"));
        assert!(!prefs.is_favorite("claudeAgent", "a"));
        assert!(prefs.is_hidden("codex", "b"));
        assert_eq!(prefs.instance("codex").model_order, strings(&["c", "a"]));
        assert_eq!(prefs.favorite_models("codex"), strings(&["a"]));
        let empty: ServerSettings =
            serde_json::from_value(json!({ "favorites": null })).expect("settings");
        assert_eq!(
            ModelPreferences::from_settings(&empty),
            ModelPreferences::default()
        );
    }

    #[test]
    fn sorting_puts_favorites_then_the_saved_order_then_the_reported_order() {
        let models = strings(&["a", "b", "c", "d"]);
        let favorites: HashSet<&str> = ["d"].into_iter().collect();
        let sorted = sort_models_for_instance(
            models.clone(),
            String::as_str,
            &strings(&["c", "a"]),
            &favorites,
            true,
        );
        assert_eq!(sorted, strings(&["d", "c", "a", "b"]));
        let ungrouped =
            sort_models_for_instance(models, String::as_str, &strings(&["c"]), &favorites, false);
        assert_eq!(ungrouped, strings(&["c", "a", "b", "d"]));
    }

    #[test]
    fn rows_group_favorites_visible_and_hidden_and_keep_unreported_favorites() {
        let models = vec![entry("a", false), entry("b", false), entry("custom", true)];
        let prefs = InstanceModelPreferences {
            hidden_models: strings(&["a", "custom"]),
            model_order: Vec::new(),
        };
        let rows = group_models_for_display(&models, &prefs, &strings(&["gone"]));
        let summary: Vec<(&str, ModelGroup)> =
            rows.iter().map(|r| (r.slug.as_str(), r.group)).collect();
        assert_eq!(
            summary,
            [
                ("gone", ModelGroup::Favorite),
                ("b", ModelGroup::Visible),
                ("custom", ModelGroup::Visible),
                ("a", ModelGroup::Hidden),
            ],
            "custom models are never hidden"
        );
        assert_eq!(
            move_model(&rows, "b", 1),
            Some(strings(&["gone", "custom", "b", "a"]))
        );
        assert_eq!(move_model(&rows, "b", -1), None, "not across groups");
        assert_eq!(move_model(&rows, "a", 1), None);
    }

    #[test]
    fn bulk_toggle_hides_all_then_shows_all() {
        let built_in = strings(&["a", "b"]);
        let (hidden, affected) = bulk_toggle_hidden(&built_in, &strings(&["x", "a"]));
        assert_eq!(hidden, strings(&["x", "a", "b"]));
        assert_eq!(affected, built_in);
        let (shown, _) = bulk_toggle_hidden(&built_in, &hidden);
        assert_eq!(shown, strings(&["x"]));
    }

    #[test]
    fn writes_are_the_patches_conn_sends() {
        assert_eq!(
            set_models_hidden_request("codex", &[("m".to_owned(), true)]),
            json!({ "patch": { "setModelsHidden": [{ "provider": "codex", "model": "m", "hidden": true }] } })
        );
        assert_eq!(
            set_model_favorites_request("codex", &[("m".to_owned(), false)]),
            json!({ "patch": { "setModelFavorites": [{ "provider": "codex", "model": "m", "favorite": false }] } })
        );
        assert_eq!(
            set_model_order_request("codex", &strings(&["b", "a"])),
            json!({ "patch": { "setProviderModelOrder": { "provider": "codex", "modelOrder": ["b", "a"] } } })
        );
    }

    #[test]
    fn custom_models_add_validate_and_remove_without_touching_other_entries() {
        let instance: InstanceConfig = serde_json::from_value(json!({
            "driver": "codex",
            "config": { "customModels": ["x", { "slug": "y", "name": "Why", "capabilities": { "optionDescriptors": [] } }, "x", " "] },
        }))
        .expect("instance");
        assert_eq!(
            custom_models(&instance),
            [
                ("x".to_owned(), "x".to_owned()),
                ("y".to_owned(), "Why".to_owned())
            ]
        );
        let built_in = strings(&["gpt"]);
        let custom = strings(&["x", "y"]);
        assert_eq!(
            validate_custom_model(" ", &built_in, &custom),
            Err("Enter a model slug.")
        );
        assert_eq!(
            validate_custom_model("gpt", &built_in, &custom),
            Err("That model is already built in.")
        );
        assert_eq!(
            validate_custom_model("x", &built_in, &custom),
            Err("That custom model is already saved.")
        );
        assert!(validate_custom_model(&"m".repeat(257), &built_in, &custom).is_err());
        assert_eq!(
            validate_custom_model(" z ", &built_in, &custom),
            Ok("z".to_owned())
        );
        let added = with_custom_model_added(&instance, "z");
        assert_eq!(custom_models(&added).len(), 3);
        let removed = with_custom_model_removed(&added, "y");
        let raw = removed.config.expect("config")["customModels"].clone();
        assert_eq!(raw, json!(["x", "x", " ", "z"]));
    }
}
