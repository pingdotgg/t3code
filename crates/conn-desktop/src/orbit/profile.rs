//! Orbit Gateway profile, workspace, appearance, and desktop settings sync.
//!
//! Port of Conn's `packages/client-runtime/src/orbitGateway/{client,profileDocument,sectionMerge,
//! workspaceMerge,profileSync}.ts` against `https://gateway.orbit/api/v1/conn`:
//! - `GET /me` — current Orbit Node and bound profile
//! - `GET /profiles` / `POST /profiles` / `PUT /me/profile` — list, create, bind profile
//! - `GET /profiles/{id}/settings` — workspaces + `appearance` + `devices.desktop` + section metas
//! - `PUT /profiles/{id}/settings` — optimistic-locked workspace replacement
//! - `PATCH /profiles/{id}/settings` — all-or-nothing optimistic-locked section updates
//!
//! All merge and normalization rules stay pure and GPUI-free so both `conn-gpui` and a future
//! SwiftUI iOS client can share the exact same behavior.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::gateway::{GatewayRequest, GatewayTransport, OrbitGateway};

/// Current schema version for `appearance` and `devices.*` profile sections.
pub const PROFILE_SCHEMA_VERSION: i64 = 1;
/// Section name for theme mode, light/dark slots, contrast, and custom themes.
pub const APPEARANCE_SECTION: &str = "appearance";
/// Section name for desktop-specific client preferences.
pub const DESKTOP_DEVICE_SECTION: &str = "devices.desktop";
/// Gateway conflict code returned on stale version writes.
pub const SETTINGS_VERSION_CONFLICT: &str = "conn.settings_version_conflict";
/// Maximum retries on version conflict before returning an error.
const MAX_CONFLICT_ATTEMPTS: usize = 3;
/// Maximum custom themes synced in one profile (Gateway limit).
pub const MAX_CUSTOM_THEMES: usize = 50;
/// Maximum keys allowed in a `devices.*` section (Gateway limit).
pub const MAX_DEVICE_KEYS: usize = 128;

/// Error from Orbit profile reads or writes.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProfileError {
    #[error("The Orbit Gateway did not answer: {0}")]
    Unreachable(String),
    #[error("The Orbit Gateway sent an unexpected {path} response.")]
    InvalidResponse { path: String },
    #[error("Orbit profile settings conflicted with a newer version.")]
    VersionConflict,
    #[error("This Orbit Gateway does not support profile section sync yet.")]
    Unsupported,
    #[error("{message}")]
    Gateway {
        code: String,
        message: String,
        status: u16,
    },
}

pub type ProfileResult<T> = Result<T, ProfileError>;

/// An Orbit user profile metadata record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrbitProfile {
    pub id: i64,
    pub name: String,
    pub settings_version: i64,
    pub updated_at: String,
}

/// The current device's Orbit Node identity and optional bound profile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrbitNode {
    pub id: i64,
    pub name: String,
    pub wireguard_ip: String,
    pub profile: Option<OrbitProfile>,
}

/// A saved workspace synced in the Orbit profile's `workspaces` list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrbitWorkspace {
    pub id: String,
    pub name: String,
    pub color: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub project_refs: Vec<String>,
    #[serde(default)]
    pub project_keys: Vec<String>,
}

/// Metadata tracking who last wrote a profile section and at what version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SectionMeta {
    pub version: i64,
    pub updated_at: Option<String>,
    pub updated_by: Option<String>,
}

/// Full settings response from `GET/PUT/PATCH /profiles/{id}/settings`.
#[derive(Debug, Clone, PartialEq)]
pub struct OrbitProfileSettings {
    pub profile_id: i64,
    pub version: i64,
    pub workspaces: Vec<OrbitWorkspace>,
    pub updated_at: String,
    /// Complete raw settings JSON document so unknown sections survive untouched.
    pub document: Map<String, Value>,
    /// Per-section version metadata, or `None` when talking to an older Gateway without PATCH.
    pub sections: Option<BTreeMap<String, SectionMeta>>,
}

/// One section entry in a `PATCH /profiles/{id}/settings` payload.
#[derive(Debug, Clone, PartialEq)]
pub struct SectionPatch {
    pub version: i64,
    pub value: Option<Map<String, Value>>,
}

/// Appearance polarity inside a profile theme or slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProfileThemeAppearance {
    Light,
    Dark,
}

/// Overall appearance mode preference (`light`, `dark`, or `system`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProfileAppearanceMode {
    Light,
    Dark,
    System,
}

/// Source kind of a resolved theme slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeSlotSource {
    Stock,
    Builtin,
    Custom,
    Published,
}

/// One appearance slot (`themes.light` or `themes.dark`) in the profile `appearance` section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ProfileThemeSlot {
    /// Custom or published theme carrying its full resolved color palette.
    Resolved {
        id: String,
        name: String,
        source: ThemeSlotSource,
        appearance: ProfileThemeAppearance,
        colors: BTreeMap<String, String>,
    },
    /// Stock or built-in theme referenced by id only.
    Reference { id: String, source: ThemeSlotSource },
}

impl ProfileThemeSlot {
    #[must_use]
    pub fn id(&self) -> &str {
        match self {
            Self::Resolved { id, .. } | Self::Reference { id, .. } => id,
        }
    }

    #[must_use]
    pub fn builtin(id: impl Into<String>) -> Self {
        Self::Reference {
            id: id.into(),
            source: ThemeSlotSource::Builtin,
        }
    }

    #[must_use]
    pub fn stock() -> Self {
        Self::Reference {
            id: "t3-code".to_owned(),
            source: ThemeSlotSource::Stock,
        }
    }
}

/// Collection badge metadata on a custom theme.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemeCollectionMeta {
    pub id: String,
    pub label: String,
}

/// Custom theme entry stored in `appearance.customThemes`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileCustomTheme {
    pub id: String,
    pub name: String,
    pub appearance: ProfileThemeAppearance,
    pub colors: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub variants: BTreeMap<ProfileThemeAppearance, BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection: Option<ThemeCollectionMeta>,
}

/// Parsed `appearance` section of an Orbit profile.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileAppearance {
    pub schema: i64,
    pub mode: ProfileAppearanceMode,
    pub contrast: f64,
    pub themes: ProfileThemeSlots,
    pub custom_themes: Vec<ProfileCustomTheme>,
}

/// Paired light and dark theme slots inside [`ProfileAppearance`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileThemeSlots {
    pub light: ProfileThemeSlot,
    pub dark: ProfileThemeSlot,
}

/// Parsed `devices.desktop` section of an Orbit profile.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProfileDeviceSection {
    pub schema: i64,
    pub values: Map<String, Value>,
}

/// Per-device Orbit sync opt-in preferences saved locally.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrbitSyncPrefs {
    pub sync_workspaces: bool,
    pub sync_appearance: bool,
    pub sync_desktop_settings: bool,
}

impl Default for OrbitSyncPrefs {
    fn default() -> Self {
        Self {
            sync_workspaces: true,
            sync_appearance: true,
            sync_desktop_settings: true,
        }
    }
}

/// Local snapshot persisted across launches so 3-way conflict merges have a known `base`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct OrbitSyncSnapshot {
    pub profile_id: Option<i64>,
    pub profile_version: i64,
    pub workspaces: Vec<OrbitWorkspace>,
    pub appearance_version: i64,
    pub appearance_base: Option<Map<String, Value>>,
    #[serde(default)]
    pub appearance_meta: Option<SectionMeta>,
    pub desktop_version: i64,
    pub desktop_base: Option<Map<String, Value>>,
    #[serde(default)]
    pub desktop_meta: Option<SectionMeta>,
    /// Local backup taken right before "Use the profile" replaces device settings.
    #[serde(default)]
    pub appearance_backup: Option<Map<String, Value>>,
    #[serde(default)]
    pub desktop_backup: Option<Map<String, Value>>,
    #[serde(default)]
    pub backup_saved_at_unix: Option<i64>,
    pub prefs: OrbitSyncPrefs,
}

impl OrbitSyncSnapshot {
    /// Default config file location (`~/Library/Application Support/conn-gpui/orbit-profile.json`),
    /// overridable with `CONN_GPUI_CONFIG_DIR` for isolated dev/test sessions.
    #[must_use]
    pub fn default_path() -> Option<PathBuf> {
        if let Some(dir) = std::env::var_os("CONN_GPUI_CONFIG_DIR") {
            return Some(PathBuf::from(dir).join("orbit-profile.json"));
        }
        let home = std::env::var_os("HOME")?;
        Some(
            PathBuf::from(home)
                .join("Library/Application Support/conn-gpui")
                .join("orbit-profile.json"),
        )
    }

    /// Loads the saved snapshot from `path`, returning `Default` when missing or unreadable.
    #[must_use]
    pub fn load_from(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    /// Persists the snapshot atomically to `path`.
    pub fn save_to(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json)?;
        std::fs::rename(tmp, path)
    }
}

// ---------------------------------------------------------------------------
// Normalization & 3-way merges (matching Conn's workspaceMerge.ts & sectionMerge.ts)
// ---------------------------------------------------------------------------

/// Trims a string as the Orbit Gateway stores it, turning empty strings into `None`.
#[must_use]
pub fn gateway_text(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

fn gateway_texts(values: &[String]) -> Vec<String> {
    values
        .iter()
        .filter_map(|v| gateway_text(Some(v.as_str())))
        .collect()
}

fn workspace_to_wire(ws: &OrbitWorkspace) -> Value {
    json!({
        "id": ws.id.trim(),
        "name": ws.name.trim(),
        "color": ws.color.trim(),
        "icon": gateway_text(ws.icon.as_deref()),
        "image": gateway_text(ws.image.as_deref()),
        "projectRefs": gateway_texts(&ws.project_refs),
        "projectKeys": gateway_texts(&ws.project_keys),
    })
}

fn same_workspace(left: Option<&OrbitWorkspace>, right: Option<&OrbitWorkspace>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(l), Some(r)) => {
            gateway_text(Some(&l.id)) == gateway_text(Some(&r.id))
                && gateway_text(Some(&l.name)) == gateway_text(Some(&r.name))
                && gateway_text(Some(&l.color)) == gateway_text(Some(&r.color))
                && gateway_text(l.icon.as_deref()) == gateway_text(r.icon.as_deref())
                && gateway_text(l.image.as_deref()) == gateway_text(r.image.as_deref())
                && gateway_texts(&l.project_refs) == gateway_texts(&r.project_refs)
                && gateway_texts(&l.project_keys) == gateway_texts(&r.project_keys)
        }
        _ => false,
    }
}

/// True when two workspace lists hold the same workspaces with the same content in the same order.
#[must_use]
pub fn same_workspaces(left: &[OrbitWorkspace], right: &[OrbitWorkspace]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right.iter())
            .all(|(l, r)| same_workspace(Some(l), Some(r)))
}

fn same_order(left: &[OrbitWorkspace], right: &[OrbitWorkspace]) -> bool {
    let shared: HashSet<&str> = left.iter().map(|w| w.id.as_str()).collect();
    let right_shared: Vec<&str> = right
        .iter()
        .map(|w| w.id.as_str())
        .filter(|id| shared.contains(id))
        .collect();
    let right_set: HashSet<&str> = right_shared.iter().copied().collect();
    let left_shared: Vec<&str> = left
        .iter()
        .map(|w| w.id.as_str())
        .filter(|id| right_set.contains(id))
        .collect();
    left_shared == right_shared
}

/// Three-way merge of profile workspaces (`base`, `local`, `remote`).
///
/// - Per id: unchanged side takes the other side (so deletions propagate cleanly).
/// - Both changed same workspace: `local` wins; edit beats delete.
/// - Order follows `remote` unless only `local` reordered; additions insert after their nearest
///   preceding neighbour from the side that added them.
#[must_use]
pub fn merge_workspaces(
    base: &[OrbitWorkspace],
    local: &[OrbitWorkspace],
    remote: &[OrbitWorkspace],
) -> Vec<OrbitWorkspace> {
    let base_by_id: HashMap<&str, &OrbitWorkspace> =
        base.iter().map(|w| (w.id.as_str(), w)).collect();
    let local_by_id: HashMap<&str, &OrbitWorkspace> =
        local.iter().map(|w| (w.id.as_str(), w)).collect();
    let remote_by_id: HashMap<&str, &OrbitWorkspace> =
        remote.iter().map(|w| (w.id.as_str(), w)).collect();

    let mut all_ids: Vec<&str> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for id in base
        .iter()
        .chain(local.iter())
        .chain(remote.iter())
        .map(|w| w.id.as_str())
    {
        if seen.insert(id) {
            all_ids.push(id);
        }
    }

    let mut resolved: HashMap<&str, OrbitWorkspace> = HashMap::new();
    for id in all_ids {
        let before = base_by_id.get(id).copied();
        let mine = local_by_id.get(id).copied();
        let theirs = remote_by_id.get(id).copied();
        let chosen = if same_workspace(mine, before) {
            theirs
        } else if same_workspace(theirs, before) {
            mine
        } else {
            mine.or(theirs)
        };
        if let Some(ws) = chosen {
            resolved.insert(id, ws.clone());
        }
    }

    let local_reordered = !same_order(base, local);
    let remote_reordered = !same_order(base, remote);
    let (primary, secondary) = if local_reordered && !remote_reordered {
        (local, remote)
    } else {
        (remote, local)
    };

    let mut ordered: Vec<OrbitWorkspace> = Vec::with_capacity(resolved.len());
    let mut placed: HashSet<String> = HashSet::new();
    for ws in primary {
        if let Some(chosen) = resolved.get(ws.id.as_str())
            && placed.insert(chosen.id.clone())
        {
            ordered.push(chosen.clone());
        }
    }
    for (index, ws) in secondary.iter().enumerate() {
        let Some(chosen) = resolved.get(ws.id.as_str()) else {
            continue;
        };
        if placed.contains(&chosen.id) {
            continue;
        }
        let mut insert_at = 0;
        for prev in (0..index).rev() {
            if let Some(pos) = ordered.iter().position(|e| e.id == secondary[prev].id) {
                insert_at = pos + 1;
                break;
            }
        }
        ordered.insert(insert_at, chosen.clone());
        placed.insert(chosen.id.clone());
    }
    ordered
}

/// Converts a section JSON object into the exact form the Orbit Gateway stores:
/// trims strings, converts empty strings to `null`, and omits empty JSON objects `{}` (which PHP's
/// JSON decoder cannot distinguish from `[]` and rejects with HTTP 422).
#[must_use]
pub fn to_gateway_form(section: &Map<String, Value>) -> Map<String, Value> {
    match gateway_value(&Value::Object(section.clone())) {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn is_empty_map(value: &Value) -> bool {
    matches!(value, Value::Object(map) if map.is_empty())
}

fn gateway_value(value: &Value) -> Value {
    match value {
        Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                Value::Null
            } else {
                Value::String(trimmed.to_owned())
            }
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(gateway_value)
                .filter(|v| !is_empty_map(v))
                .collect(),
        ),
        Value::Object(map) => {
            let mut out = Map::new();
            for (k, v) in map {
                let normalized = gateway_value(v);
                if !is_empty_map(&normalized) {
                    out.insert(k.clone(), normalized);
                }
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn json_equal(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(Value::Array(a)), Some(Value::Array(b))) => {
            a.len() == b.len()
                && a.iter()
                    .zip(b.iter())
                    .all(|(x, y)| json_equal(Some(x), Some(y)))
        }
        (Some(Value::Object(a)), Some(Value::Object(b))) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(k, v)| b.get(k).is_some_and(|bv| json_equal(Some(v), Some(bv))))
        }
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

fn merge_keyed_with<F>(
    base: Option<&Map<String, Value>>,
    local: &Map<String, Value>,
    remote: &Map<String, Value>,
    special: F,
) -> Map<String, Value>
where
    F: Fn(&str, Option<&Value>, &Value, Option<&Value>) -> Option<Value>,
{
    let mut keys: Vec<&str> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for k in local.keys().chain(remote.keys()) {
        if seen.insert(k.as_str()) {
            keys.push(k.as_str());
        }
    }

    let mut merged = Map::new();
    for key in keys {
        let mine = local.get(key);
        let theirs = remote.get(key);
        let Some(mine) = mine else {
            if let Some(theirs) = theirs {
                merged.insert(key.to_owned(), theirs.clone());
            }
            continue;
        };
        let before = base.and_then(|b| b.get(key));
        let chosen = if let Some(custom) = special(key, before, mine, theirs) {
            custom
        } else if theirs.is_none() || json_equal(Some(mine), before) {
            theirs.unwrap_or(mine).clone()
        } else {
            mine.clone()
        };
        merged.insert(key.to_owned(), chosen);
    }
    merged
}

fn merge_by_id(base: Option<&[Value]>, local: &[Value], remote: Option<&[Value]>) -> Vec<Value> {
    let index = |list: Option<&[Value]>| -> HashMap<String, Value> {
        list.unwrap_or(&[])
            .iter()
            .filter_map(|entry| {
                let id = entry.as_object()?.get("id")?.as_str()?;
                Some((id.to_owned(), entry.clone()))
            })
            .collect()
    };
    let base_by_id = index(base);
    let local_by_id = index(Some(local));
    let remote_by_id = index(remote.or(Some(local)));

    let mut ids: Vec<String> = base_by_id
        .keys()
        .chain(local_by_id.keys())
        .chain(remote_by_id.keys())
        .cloned()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    ids.sort();

    let mut merged = Vec::new();
    for id in ids {
        let before = base_by_id.get(&id);
        let mine = local_by_id.get(&id);
        let theirs = remote_by_id.get(&id);
        let chosen = if json_equal(mine, before) {
            theirs
        } else if json_equal(theirs, before) {
            mine
        } else {
            mine.or(theirs)
        };
        if let Some(val) = chosen {
            merged.push(val.clone());
        }
    }
    merged
}

fn is_newer_schema(remote: &Map<String, Value>) -> bool {
    remote
        .get("schema")
        .and_then(Value::as_i64)
        .is_some_and(|s| s > PROFILE_SCHEMA_VERSION)
}

/// Three-way merge of the `appearance` section.
///
/// Newer schemas are returned verbatim so an older client never downgrades them.
#[must_use]
pub fn merge_appearance(
    base: Option<&Map<String, Value>>,
    local: &Map<String, Value>,
    remote: &Map<String, Value>,
) -> Map<String, Value> {
    if is_newer_schema(remote) {
        return remote.clone();
    }
    merge_keyed_with(base, local, remote, |key, before, mine, theirs| match key {
        "themes" => {
            let mine_obj = mine.as_object()?;
            let empty = Map::new();
            let theirs_obj = theirs.and_then(Value::as_object).unwrap_or(&empty);
            let merged_themes = merge_keyed_with(
                before.and_then(Value::as_object),
                mine_obj,
                theirs_obj,
                |_, _, _, _| None,
            );
            Some(Value::Object(merged_themes))
        }
        "customThemes" => {
            let mine_arr = mine.as_array()?;
            let merged_list = merge_by_id(
                before.and_then(Value::as_array).map(Vec::as_slice),
                mine_arr,
                theirs.and_then(Value::as_array).map(Vec::as_slice),
            );
            Some(Value::Array(merged_list))
        }
        _ => None,
    })
}

/// Three-way merge of a `devices.*` section, preserving unknown keys from other builds.
#[must_use]
pub fn merge_device_section(
    base: Option<&Map<String, Value>>,
    local: &Map<String, Value>,
    remote: &Map<String, Value>,
) -> Map<String, Value> {
    if is_newer_schema(remote) {
        return remote.clone();
    }
    merge_keyed_with(base, local, remote, |key, before, mine, theirs| {
        if key != "values" {
            return None;
        }
        let mine_obj = mine.as_object()?;
        let empty = Map::new();
        let theirs_obj = theirs.and_then(Value::as_object).unwrap_or(&empty);
        let merged = merge_keyed_with(
            before.and_then(Value::as_object),
            mine_obj,
            theirs_obj,
            |_, _, _, _| None,
        );
        if merged.len() > MAX_DEVICE_KEYS {
            return theirs.cloned();
        }
        Some(Value::Object(merged))
    })
}

// ---------------------------------------------------------------------------
// Document section parsers
// ---------------------------------------------------------------------------

/// Parses `document["appearance"]` when it matches the shape this client understands.
#[must_use]
pub fn parse_profile_appearance(value: &Value) -> Option<ProfileAppearance> {
    let obj = value.as_object()?;
    let schema = obj.get("schema")?.as_i64()?;
    let mode: ProfileAppearanceMode = serde_json::from_value(obj.get("mode")?.clone()).ok()?;
    let contrast = obj.get("contrast")?.as_f64()?;
    if !contrast.is_finite() {
        return None;
    }
    let themes_obj = obj.get("themes")?.as_object()?;
    let light = parse_theme_slot(themes_obj.get("light")?)?;
    let dark = parse_theme_slot(themes_obj.get("dark")?)?;
    let custom_raw = obj.get("customThemes")?.as_array()?;
    let custom_themes = custom_raw
        .iter()
        .filter_map(parse_custom_theme)
        .take(MAX_CUSTOM_THEMES)
        .collect();
    Some(ProfileAppearance {
        schema,
        mode,
        contrast,
        themes: ProfileThemeSlots { light, dark },
        custom_themes,
    })
}

fn parse_colors_map(value: &Value) -> Option<BTreeMap<String, String>> {
    let obj = value.as_object()?;
    let mut out = BTreeMap::new();
    for (k, v) in obj {
        out.insert(k.clone(), v.as_str()?.to_owned());
    }
    Some(out)
}

fn parse_theme_slot(value: &Value) -> Option<ProfileThemeSlot> {
    let obj = value.as_object()?;
    let id = obj.get("id")?.as_str()?.to_owned();
    let source: ThemeSlotSource = serde_json::from_value(obj.get("source")?.clone()).ok()?;
    match source {
        ThemeSlotSource::Stock | ThemeSlotSource::Builtin => {
            Some(ProfileThemeSlot::Reference { id, source })
        }
        ThemeSlotSource::Custom | ThemeSlotSource::Published => {
            let name = obj.get("name")?.as_str()?.to_owned();
            let appearance: ProfileThemeAppearance =
                serde_json::from_value(obj.get("appearance")?.clone()).ok()?;
            let colors = parse_colors_map(obj.get("colors")?)?;
            Some(ProfileThemeSlot::Resolved {
                id,
                name,
                source,
                appearance,
                colors,
            })
        }
    }
}

fn parse_custom_theme(value: &Value) -> Option<ProfileCustomTheme> {
    let obj = value.as_object()?;
    let id = obj.get("id")?.as_str()?.to_owned();
    let name = obj.get("name")?.as_str()?.to_owned();
    let appearance: ProfileThemeAppearance =
        serde_json::from_value(obj.get("appearance")?.clone()).ok()?;
    let colors = parse_colors_map(obj.get("colors")?)?;
    let mut variants = BTreeMap::new();
    if let Some(raw_variants) = obj.get("variants") {
        let vmap = raw_variants.as_object()?;
        for (k, v) in vmap {
            let var_app: ProfileThemeAppearance =
                serde_json::from_value(Value::String(k.clone())).ok()?;
            variants.insert(var_app, parse_colors_map(v)?);
        }
    }
    let collection = obj
        .get("collection")
        .and_then(|v| serde_json::from_value::<ThemeCollectionMeta>(v.clone()).ok());
    Some(ProfileCustomTheme {
        id,
        name,
        appearance,
        colors,
        variants,
        collection,
    })
}

/// Parses `document["devices"]["desktop"]` when present and well-formed.
#[must_use]
pub fn parse_profile_device_section(value: &Value) -> Option<ProfileDeviceSection> {
    let obj = value.as_object()?;
    let schema = obj.get("schema")?.as_i64()?;
    let values = obj.get("values")?.as_object()?.clone();
    Some(ProfileDeviceSection { schema, values })
}

/// Extracts a raw section JSON object from an [`OrbitProfileSettings`] document.
#[must_use]
pub fn extract_section(
    settings: &OrbitProfileSettings,
    section_name: &str,
) -> Option<Map<String, Value>> {
    if section_name == APPEARANCE_SECTION {
        settings
            .document
            .get(APPEARANCE_SECTION)
            .and_then(Value::as_object)
            .cloned()
    } else if let Some(device) = section_name.strip_prefix("devices.") {
        settings
            .document
            .get("devices")
            .and_then(Value::as_object)
            .and_then(|d| d.get(device))
            .and_then(Value::as_object)
            .cloned()
    } else {
        None
    }
}

/// Matches a project (id, title, workspace_root) against an [`OrbitWorkspace`]'s
/// `project_refs` and `project_keys`.
#[must_use]
pub fn workspace_matches_project(
    workspace: &OrbitWorkspace,
    project_id: &str,
    project_title: &str,
    workspace_root: &str,
) -> bool {
    let normalized_root = workspace_root.trim_end_matches('/');
    let dir_name = Path::new(normalized_root)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    workspace
        .project_refs
        .iter()
        .chain(workspace.project_keys.iter())
        .any(|entry| {
            let candidate = entry.trim().trim_end_matches('/');
            if candidate.is_empty() {
                return false;
            }
            if candidate == project_id || candidate == normalized_root {
                return true;
            }
            // Match `envId:projectId` or `envId:/abs/path` composite refs.
            if let Some((_, suffix)) = candidate.split_once(':')
                && (suffix == project_id || suffix.trim_end_matches('/') == normalized_root)
            {
                return true;
            }
            // Match repo/title slug fallback when project_keys store folder or repo name.
            !dir_name.is_empty()
                && (candidate.eq_ignore_ascii_case(dir_name)
                    || candidate.eq_ignore_ascii_case(project_title)
                    || candidate
                        .rsplit('/')
                        .next()
                        .is_some_and(|leaf| leaf.eq_ignore_ascii_case(dir_name)))
        })
}

// ---------------------------------------------------------------------------
// Async Gateway client
// ---------------------------------------------------------------------------

/// Orbit Gateway client for `/me`, `/profiles`, and `/profiles/{id}/settings`.
#[derive(Clone)]
pub struct OrbitProfileClient {
    transport: Arc<dyn GatewayTransport>,
}

impl std::fmt::Debug for OrbitProfileClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OrbitProfileClient").finish_non_exhaustive()
    }
}

impl OrbitProfileClient {
    pub fn new(transport: Arc<dyn GatewayTransport>) -> Self {
        Self { transport }
    }

    /// Live client targeting `https://gateway.orbit` with macOS system keychain roots.
    pub fn live() -> Result<Self, super::gateway::GatewayError> {
        Ok(Self::new(Arc::new(OrbitGateway::new()?)))
    }

    async fn call(&self, request: GatewayRequest) -> ProfileResult<Value> {
        let path = request.path.clone();
        let response = self
            .transport
            .send(request)
            .await
            .map_err(|err| ProfileError::Unreachable(err.to_string()))?;
        let json = serde_json::from_str::<Value>(&response.body).unwrap_or(Value::Null);
        if !(200..300).contains(&response.status) {
            let err_obj = json.get("error").and_then(Value::as_object);
            let code = err_obj
                .and_then(|e| e.get("code"))
                .and_then(Value::as_str)
                .unwrap_or("gateway.request_failed")
                .to_owned();
            if code == SETTINGS_VERSION_CONFLICT {
                return Err(ProfileError::VersionConflict);
            }
            let message = err_obj
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .map_or_else(
                    || format!("The Orbit Gateway answered {}.", response.status),
                    ToOwned::to_owned,
                );
            return Err(ProfileError::Gateway {
                code,
                message,
                status: response.status,
            });
        }
        json.get("data")
            .cloned()
            .ok_or(ProfileError::InvalidResponse { path })
    }

    /// `GET /me`
    pub async fn me(&self) -> ProfileResult<OrbitNode> {
        let data = self.call(GatewayRequest::get("/me")).await?;
        decode_node(&data, "/me")
    }

    /// `GET /profiles`
    pub async fn profiles(&self) -> ProfileResult<Vec<OrbitProfile>> {
        let data = self.call(GatewayRequest::get("/profiles")).await?;
        let arr = data.as_array().ok_or(ProfileError::InvalidResponse {
            path: "/profiles".to_owned(),
        })?;
        arr.iter().map(|v| decode_profile(v, "/profiles")).collect()
    }

    /// `POST /profiles`
    pub async fn create_profile(&self, name: &str) -> ProfileResult<OrbitProfile> {
        let body = json!({ "name": name }).to_string();
        let data = self
            .call(GatewayRequest::post("/profiles").with_body(body))
            .await?;
        decode_profile(&data, "/profiles")
    }

    /// `PUT /me/profile`
    pub async fn bind_profile(&self, profile_id: i64) -> ProfileResult<OrbitNode> {
        let body = json!({ "profile_id": profile_id }).to_string();
        let data = self
            .call(GatewayRequest::put("/me/profile").with_body(body))
            .await?;
        decode_node(&data, "/me/profile")
    }

    /// `GET /profiles/{id}/settings`
    pub async fn settings(&self, profile_id: i64) -> ProfileResult<OrbitProfileSettings> {
        let path = format!("/profiles/{profile_id}/settings");
        let data = self.call(GatewayRequest::get(path)).await?;
        decode_settings(&data, "/profiles/settings")
    }

    /// `PUT /profiles/{id}/settings` — replaces the workspaces list with optimistic locking.
    pub async fn replace_workspaces(
        &self,
        profile_id: i64,
        version: i64,
        workspaces: &[OrbitWorkspace],
    ) -> ProfileResult<OrbitProfileSettings> {
        let path = format!("/profiles/{profile_id}/settings");
        let wire: Vec<Value> = workspaces.iter().map(workspace_to_wire).collect();
        let body = json!({
            "version": version,
            "settings": { "workspaces": wire },
        })
        .to_string();
        let data = self.call(GatewayRequest::put(path).with_body(body)).await?;
        decode_settings(&data, "/profiles/settings")
    }

    /// `PATCH /profiles/{id}/settings` — updates one or more named sections atomically.
    pub async fn patch_sections(
        &self,
        profile_id: i64,
        sections: &BTreeMap<String, SectionPatch>,
    ) -> ProfileResult<OrbitProfileSettings> {
        let path = format!("/profiles/{profile_id}/settings");
        let mut wire_sections = Map::new();
        for (name, patch) in sections {
            let val = match &patch.value {
                Some(obj) => Value::Object(to_gateway_form(obj)),
                None => Value::Null,
            };
            wire_sections.insert(
                name.clone(),
                json!({
                    "version": patch.version,
                    "value": val,
                }),
            );
        }
        let body = json!({ "sections": wire_sections }).to_string();
        match self.call(GatewayRequest::patch(path).with_body(body)).await {
            Ok(data) => decode_settings(&data, "/profiles/settings"),
            Err(ProfileError::Gateway {
                status: 404 | 405, ..
            }) => Err(ProfileError::Unsupported),
            Err(err) => Err(err),
        }
    }

    /// Pushes local workspace edits with automatic 3-way merge & retry on version conflict.
    pub async fn push_workspaces_merged(
        &self,
        profile_id: i64,
        base: &[OrbitWorkspace],
        local: &[OrbitWorkspace],
        initial_version: i64,
    ) -> ProfileResult<OrbitProfileSettings> {
        let mut version = initial_version;
        let mut candidate = local.to_vec();
        for attempt in 1..=MAX_CONFLICT_ATTEMPTS {
            match self
                .replace_workspaces(profile_id, version, &candidate)
                .await
            {
                Ok(saved) => return Ok(saved),
                Err(ProfileError::VersionConflict) if attempt < MAX_CONFLICT_ATTEMPTS => {
                    let latest = self.settings(profile_id).await?;
                    candidate = merge_workspaces(base, local, &latest.workspaces);
                    version = latest.version;
                }
                Err(err) => return Err(err),
            }
        }
        Err(ProfileError::VersionConflict)
    }

    /// Pushes a single profile section (`appearance` or `devices.desktop`) with 3-way conflict
    /// merge & retry (`MAX_CONFLICT_ATTEMPTS`).
    pub async fn push_section_merged<M>(
        &self,
        profile_id: i64,
        section_name: &str,
        base: Option<&Map<String, Value>>,
        local: &Map<String, Value>,
        initial_version: i64,
        merge_fn: M,
    ) -> ProfileResult<OrbitProfileSettings>
    where
        M: Fn(
            Option<&Map<String, Value>>,
            &Map<String, Value>,
            &Map<String, Value>,
        ) -> Map<String, Value>,
    {
        let mut version = initial_version;
        let mut candidate = to_gateway_form(local);
        for attempt in 1..=MAX_CONFLICT_ATTEMPTS {
            let mut patches = BTreeMap::new();
            patches.insert(
                section_name.to_owned(),
                SectionPatch {
                    version,
                    value: Some(candidate.clone()),
                },
            );
            match self.patch_sections(profile_id, &patches).await {
                Ok(saved) => return Ok(saved),
                Err(ProfileError::VersionConflict) if attempt < MAX_CONFLICT_ATTEMPTS => {
                    let latest = self.settings(profile_id).await?;
                    let remote_version = latest
                        .sections
                        .as_ref()
                        .and_then(|s| s.get(section_name))
                        .map_or(0, |meta| meta.version);
                    candidate = match extract_section(&latest, section_name) {
                        Some(remote_obj) => {
                            to_gateway_form(&merge_fn(base, &to_gateway_form(local), &remote_obj))
                        }
                        None => to_gateway_form(local),
                    };
                    version = remote_version;
                }
                Err(err) => return Err(err),
            }
        }
        Err(ProfileError::VersionConflict)
    }
}

// ---------------------------------------------------------------------------
// Wire decoders
// ---------------------------------------------------------------------------

fn invalid(path: &str) -> ProfileError {
    ProfileError::InvalidResponse {
        path: path.to_owned(),
    }
}

fn decode_profile(value: &Value, path: &str) -> ProfileResult<OrbitProfile> {
    let obj = value.as_object().ok_or_else(|| invalid(path))?;
    Ok(OrbitProfile {
        id: obj
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| invalid(path))?,
        name: obj
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid(path))?
            .to_owned(),
        settings_version: obj
            .get("settings_version")
            .and_then(Value::as_i64)
            .ok_or_else(|| invalid(path))?,
        updated_at: obj
            .get("updated_at")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid(path))?
            .to_owned(),
    })
}

fn decode_node(value: &Value, path: &str) -> ProfileResult<OrbitNode> {
    let obj = value.as_object().ok_or_else(|| invalid(path))?;
    let profile = match obj.get("profile") {
        None | Some(Value::Null) => None,
        Some(other) => Some(decode_profile(other, path)?),
    };
    Ok(OrbitNode {
        id: obj
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| invalid(path))?,
        name: obj
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid(path))?
            .to_owned(),
        wireguard_ip: obj
            .get("wireguard_ip")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid(path))?
            .to_owned(),
        profile,
    })
}

fn decode_string_vec(value: Option<&Value>, path: &str) -> ProfileResult<Vec<String>> {
    let Some(val) = value else {
        return Ok(Vec::new());
    };
    if val.is_null() {
        return Ok(Vec::new());
    }
    let arr = val.as_array().ok_or_else(|| invalid(path))?;
    arr.iter()
        .map(|v| {
            v.as_str()
                .map(ToOwned::to_owned)
                .ok_or_else(|| invalid(path))
        })
        .collect()
}

fn decode_workspace(value: &Value, path: &str) -> ProfileResult<OrbitWorkspace> {
    let obj = value.as_object().ok_or_else(|| invalid(path))?;
    let icon = match obj.get("icon") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => return Err(invalid(path)),
    };
    let image = match obj.get("image") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => return Err(invalid(path)),
    };
    Ok(OrbitWorkspace {
        id: obj
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid(path))?
            .to_owned(),
        name: obj
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid(path))?
            .to_owned(),
        color: obj
            .get("color")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid(path))?
            .to_owned(),
        icon,
        image,
        project_refs: decode_string_vec(obj.get("projectRefs"), path)?,
        project_keys: decode_string_vec(obj.get("projectKeys"), path)?,
    })
}

fn decode_sections(value: Option<&Value>) -> Option<BTreeMap<String, SectionMeta>> {
    let obj = value?.as_object()?;
    let mut out = BTreeMap::new();
    for (name, entry) in obj {
        let Some(meta) = entry.as_object() else {
            continue;
        };
        let Some(version) = meta.get("version").and_then(Value::as_i64) else {
            continue;
        };
        let updated_at = meta
            .get("updated_at")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        let updated_by = match meta.get("updated_by") {
            Some(Value::String(s)) => Some(s.clone()),
            Some(Value::Object(by)) => by
                .get("name")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            _ => None,
        };
        out.insert(
            name.clone(),
            SectionMeta {
                version,
                updated_at,
                updated_by,
            },
        );
    }
    Some(out)
}

fn decode_settings(value: &Value, path: &str) -> ProfileResult<OrbitProfileSettings> {
    let obj = value.as_object().ok_or_else(|| invalid(path))?;
    let document = obj
        .get("settings")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid(path))?
        .clone();
    let workspaces_raw = document
        .get("workspaces")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid(path))?;
    let workspaces = workspaces_raw
        .iter()
        .map(|entry| decode_workspace(entry, path))
        .collect::<ProfileResult<Vec<_>>>()?;
    Ok(OrbitProfileSettings {
        profile_id: obj
            .get("profile_id")
            .and_then(Value::as_i64)
            .ok_or_else(|| invalid(path))?,
        version: obj
            .get("version")
            .and_then(Value::as_i64)
            .ok_or_else(|| invalid(path))?,
        updated_at: obj
            .get("updated_at")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid(path))?
            .to_owned(),
        workspaces,
        document,
        sections: decode_sections(obj.get("sections")),
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::orbit::gateway::{BoxFuture, GatewayError, GatewayMethod, GatewayResponse};

    fn ws(id: &str, name: &str, color: &str) -> OrbitWorkspace {
        OrbitWorkspace {
            id: id.to_owned(),
            name: name.to_owned(),
            color: color.to_owned(),
            icon: None,
            image: None,
            project_refs: Vec::new(),
            project_keys: Vec::new(),
        }
    }

    #[test]
    fn merge_workspaces_propagates_deletes_and_local_beats_delete() {
        let base = vec![ws("a", "Alpha", "#111"), ws("b", "Beta", "#222")];
        // Local edited Beta, kept Alpha untouched.
        let local = vec![ws("a", "Alpha", "#111"), ws("b", "Beta Edited", "#222")];
        // Remote deleted both Alpha and Beta, added Gamma.
        let remote = vec![ws("c", "Gamma", "#333")];

        let merged = merge_workspaces(&base, &local, &remote);
        // Alpha was deleted remotely and untouched locally -> removed.
        // Beta was edited locally and deleted remotely -> edit beats delete.
        // Gamma was added remotely -> kept.
        let ids: Vec<&str> = merged.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, vec!["b", "c"]);
        assert_eq!(merged[0].name, "Beta Edited");
    }

    #[test]
    fn merge_workspaces_preserves_local_reorder_when_remote_did_not_reorder() {
        let base = vec![ws("a", "A", "#111"), ws("b", "B", "#222")];
        let local = vec![ws("b", "B", "#222"), ws("a", "A", "#111")];
        let remote = vec![
            ws("a", "A", "#111"),
            ws("b", "B", "#222"),
            ws("c", "C", "#333"),
        ];

        let merged = merge_workspaces(&base, &local, &remote);
        let ids: Vec<&str> = merged.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, vec!["b", "c", "a"]);
    }

    #[test]
    fn to_gateway_form_trims_strings_and_strips_empty_maps() {
        let mut input = Map::new();
        input.insert("name".into(), json!("  Nick  "));
        input.insert("empty".into(), json!("   "));
        input.insert("emptyObj".into(), json!({}));
        input.insert("nested".into(), json!({ "a": {}, "b": " ok " }));

        let out = to_gateway_form(&input);
        assert_eq!(out.get("name"), Some(&json!("Nick")));
        assert_eq!(out.get("empty"), Some(&Value::Null));
        assert!(!out.contains_key("emptyObj"));
        assert_eq!(out.get("nested"), Some(&json!({ "b": "ok" })));
    }

    #[test]
    fn merge_appearance_merges_theme_slots_and_custom_themes_by_id() {
        let base = json!({
            "schema": 1,
            "mode": "dark",
            "contrast": 50,
            "themes": {
                "light": { "id": "t3-code-light", "source": "builtin" },
                "dark": { "id": "dark-mono", "source": "builtin" }
            },
            "customThemes": [
                { "id": "t1", "name": "One", "appearance": "dark", "colors": { "canvas": "#111111" } }
            ]
        });
        let local = json!({
            "schema": 1,
            "mode": "dark",
            "contrast": 50,
            "themes": {
                "light": { "id": "t3-code-light", "source": "builtin" },
                "dark": { "id": "dark-ocean", "source": "builtin" }
            },
            "customThemes": [
                { "id": "t1", "name": "One", "appearance": "dark", "colors": { "canvas": "#111111" } },
                { "id": "t2", "name": "Local Two", "appearance": "dark", "colors": { "canvas": "#222222" } }
            ]
        });
        let remote = json!({
            "schema": 1,
            "mode": "system",
            "contrast": 50,
            "themes": {
                "light": { "id": "grove", "source": "builtin" },
                "dark": { "id": "dark-mono", "source": "builtin" }
            },
            "customThemes": [
                { "id": "t1", "name": "One", "appearance": "dark", "colors": { "canvas": "#111111" } },
                { "id": "t3", "name": "Remote Three", "appearance": "light", "colors": { "canvas": "#fafafa" } }
            ]
        });

        let merged = merge_appearance(
            base.as_object(),
            local.as_object().unwrap(),
            remote.as_object().unwrap(),
        );
        assert_eq!(merged.get("mode"), Some(&json!("system")));
        assert_eq!(
            merged["themes"]["light"]["id"],
            json!("grove"),
            "untouched light slot adopts remote"
        );
        assert_eq!(
            merged["themes"]["dark"]["id"],
            json!("dark-ocean"),
            "locally edited dark slot wins"
        );
        let custom_ids: Vec<&str> = merged["customThemes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["id"].as_str().unwrap())
            .collect();
        assert_eq!(custom_ids, vec!["t1", "t2", "t3"]);
    }

    #[test]
    fn merge_device_section_keeps_unknown_remote_keys_and_newer_schema() {
        let base = json!({ "schema": 1, "values": { "wordWrap": true } });
        let local = json!({ "schema": 1, "values": { "wordWrap": false } });
        let remote = json!({
            "schema": 1,
            "values": { "wordWrap": true, "futureKeyFromMobile": "keep-me" }
        });
        let merged = merge_device_section(
            base.as_object(),
            local.as_object().unwrap(),
            remote.as_object().unwrap(),
        );
        assert_eq!(merged["values"]["wordWrap"], json!(false));
        assert_eq!(merged["values"]["futureKeyFromMobile"], json!("keep-me"));

        let newer = json!({ "schema": 99, "values": { "wordWrap": true } });
        let preserved = merge_device_section(
            base.as_object(),
            local.as_object().unwrap(),
            newer.as_object().unwrap(),
        );
        assert_eq!(preserved["schema"], json!(99));
    }

    #[test]
    fn workspace_matches_project_by_id_root_composite_ref_or_dir_name() {
        let mut workspace = ws("w1", "Orbit", "#3b82f6");
        workspace.project_refs = vec!["env1:/Users/nick/apps/conn-gpui".to_owned()];
        workspace.project_keys = vec!["hardimpactdev/orbit".to_owned()];

        assert!(workspace_matches_project(
            &workspace,
            "p1",
            "conn-gpui",
            "/Users/nick/apps/conn-gpui/"
        ));
        assert!(workspace_matches_project(
            &workspace,
            "p2",
            "Orbit",
            "/Users/nick/apps/orbit"
        ));
        assert!(!workspace_matches_project(
            &workspace,
            "p3",
            "other",
            "/Users/nick/apps/other"
        ));
    }

    struct MockTransport {
        responses: Mutex<Vec<(GatewayMethod, String, GatewayResponse)>>,
    }

    impl GatewayTransport for MockTransport {
        fn send(
            &self,
            request: GatewayRequest,
        ) -> BoxFuture<'_, Result<GatewayResponse, GatewayError>> {
            let mut guard = self.responses.lock().unwrap();
            let next = guard.remove(0);
            assert_eq!(request.method, next.0);
            assert_eq!(request.path, next.1);
            Box::pin(async move { Ok(next.2) })
        }
    }

    #[tokio::test]
    async fn push_section_merged_retries_after_version_conflict() {
        let remote_doc = json!({
            "data": {
                "profile_id": 7,
                "version": 4,
                "updated_at": "2026-11-21T16:00:00Z",
                "settings": {
                    "workspaces": [],
                    "appearance": {
                        "schema": 1,
                        "mode": "dark",
                        "contrast": 50,
                        "themes": {
                            "light": { "id": "grove", "source": "builtin" },
                            "dark": { "id": "dark-mono", "source": "builtin" }
                        },
                        "customThemes": []
                    }
                },
                "sections": {
                    "appearance": { "version": 3, "updated_at": "2026-11-21T16:00:00Z", "updated_by": "iPhone" }
                }
            }
        });
        let saved_doc = json!({
            "data": {
                "profile_id": 7,
                "version": 5,
                "updated_at": "2026-11-21T16:01:00Z",
                "settings": {
                    "workspaces": [],
                    "appearance": {
                        "schema": 1,
                        "mode": "dark",
                        "contrast": 50,
                        "themes": {
                            "light": { "id": "grove", "source": "builtin" },
                            "dark": { "id": "dark-ocean", "source": "builtin" }
                        },
                        "customThemes": []
                    }
                },
                "sections": {
                    "appearance": { "version": 4, "updated_at": "2026-11-21T16:01:00Z", "updated_by": "Mac" }
                }
            }
        });

        let transport = Arc::new(MockTransport {
            responses: Mutex::new(vec![
                (
                    GatewayMethod::Patch,
                    "/profiles/7/settings".to_owned(),
                    GatewayResponse {
                        status: 409,
                        body: json!({ "error": { "code": SETTINGS_VERSION_CONFLICT, "message": "conflict" } }).to_string(),
                    },
                ),
                (
                    GatewayMethod::Get,
                    "/profiles/7/settings".to_owned(),
                    GatewayResponse {
                        status: 200,
                        body: remote_doc.to_string(),
                    },
                ),
                (
                    GatewayMethod::Patch,
                    "/profiles/7/settings".to_owned(),
                    GatewayResponse {
                        status: 200,
                        body: saved_doc.to_string(),
                    },
                ),
            ]),
        });

        let client = OrbitProfileClient::new(transport);
        let base = json!({
            "schema": 1,
            "mode": "dark",
            "contrast": 50,
            "themes": {
                "light": { "id": "t3-code-light", "source": "builtin" },
                "dark": { "id": "dark-mono", "source": "builtin" }
            },
            "customThemes": []
        });
        let local = json!({
            "schema": 1,
            "mode": "dark",
            "contrast": 50,
            "themes": {
                "light": { "id": "t3-code-light", "source": "builtin" },
                "dark": { "id": "dark-ocean", "source": "builtin" }
            },
            "customThemes": []
        });

        let result = client
            .push_section_merged(
                7,
                APPEARANCE_SECTION,
                base.as_object(),
                local.as_object().unwrap(),
                2,
                merge_appearance,
            )
            .await
            .expect("retry succeeds");
        assert_eq!(result.version, 5);
        assert_eq!(result.sections.unwrap()["appearance"].version, 4);
    }

    #[test]
    fn snapshot_round_trips_to_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("orbit-profile.json");
        let snap = OrbitSyncSnapshot {
            profile_id: Some(42),
            profile_version: 9,
            workspaces: vec![ws("w1", "Conn", "#3b82f6")],
            ..OrbitSyncSnapshot::default()
        };
        snap.save_to(&path).unwrap();
        let loaded = OrbitSyncSnapshot::load_from(&path);
        assert_eq!(loaded, snap);
    }
}
