//! Orbit profile, workspace, theme, and desktop settings sync controller for `conn-app`.
//!
//! Bridges [`conn_desktop::orbit::OrbitProfileClient`] (running on [`crate::live::RT`]) with
//! [`crate::app::ConnApp`]'s UI state, workspace rail, custom theme catalog, and Settings modal.

use std::collections::BTreeMap;

use conn_desktop::orbit::{
    APPEARANCE_SECTION, DESKTOP_DEVICE_SECTION, OrbitNode, OrbitProfile, OrbitProfileClient,
    OrbitProfileSettings, OrbitSyncPrefs, OrbitSyncSnapshot, OrbitWorkspace,
    PROFILE_SCHEMA_VERSION, ProfileAppearance, ProfileAppearanceMode, ProfileError,
    ProfileThemeAppearance, ProfileThemeSlot, ThemeSlotSource, extract_section, merge_appearance,
    merge_device_section, parse_profile_appearance, parse_profile_device_section,
};
use conn_theme::{Appearance, Rgba, ThemeDefinition, theme_from_role_colors};
use serde_json::{Map, Value, json};

/// High-level Orbit Gateway sync status shown in Settings → Connections.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) enum OrbitSyncStatus {
    #[default]
    Idle,
    Syncing,
    Synced {
        node_name: String,
        profile_name: String,
        workspace_count: usize,
        custom_theme_count: usize,
    },
    Unbound {
        node_name: String,
    },
    Offline(String),
}

/// Snapshot of Orbit sync state displayed inside the Settings modal.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct OrbitSettingsInfo {
    pub(crate) status: OrbitSyncStatus,
    pub(crate) active_profile_id: Option<i64>,
    pub(crate) profiles: Vec<OrbitProfile>,
    pub(crate) prefs: OrbitSyncPrefs,
}

/// Full result returned by a background Orbit profile sync fetch.
#[derive(Clone, Debug)]
pub(crate) struct OrbitFetchResult {
    pub(crate) node: OrbitNode,
    pub(crate) profiles: Vec<OrbitProfile>,
    pub(crate) settings: Option<OrbitProfileSettings>,
}

/// App-owned Orbit profile sync state.
#[derive(Clone, Debug)]
pub(crate) struct OrbitSyncState {
    pub(crate) status: OrbitSyncStatus,
    pub(crate) node: Option<OrbitNode>,
    pub(crate) profiles: Vec<OrbitProfile>,
    pub(crate) workspaces: Vec<OrbitWorkspace>,
    pub(crate) custom_themes: Vec<ThemeDefinition>,
    pub(crate) snapshot: OrbitSyncSnapshot,
    /// Active light and dark theme ids last synced with the profile.
    pub(crate) light_theme_id: String,
    pub(crate) dark_theme_id: String,
}

impl Default for OrbitSyncState {
    fn default() -> Self {
        let snapshot = OrbitSyncSnapshot::default_path()
            .map(|p| OrbitSyncSnapshot::load_from(&p))
            .unwrap_or_default();
        let workspaces = snapshot.workspaces.clone();
        let mut custom_themes = Vec::new();
        let mut light_theme_id = "t3-code-light".to_owned();
        let mut dark_theme_id = "dark-mono".to_owned();
        if let Some(base) = &snapshot.appearance_base
            && let Some(parsed) = parse_profile_appearance(&Value::Object(base.clone()))
        {
            custom_themes = themes_from_profile_appearance(&parsed);
            light_theme_id = normalize_slot_theme_id(&parsed.themes.light, Appearance::Light);
            dark_theme_id = normalize_slot_theme_id(&parsed.themes.dark, Appearance::Dark);
        }
        Self {
            status: OrbitSyncStatus::Idle,
            node: None,
            profiles: Vec::new(),
            workspaces,
            custom_themes,
            snapshot,
            light_theme_id,
            dark_theme_id,
        }
    }
}

impl OrbitSyncState {
    /// Builds the summary passed into Settings → Connections.
    #[must_use]
    pub(crate) fn settings_info(&self) -> OrbitSettingsInfo {
        OrbitSettingsInfo {
            status: self.status.clone(),
            active_profile_id: self.active_profile_id(),
            profiles: self.profiles.clone(),
            prefs: self.snapshot.prefs.clone(),
        }
    }

    /// Active Orbit profile id from the live node or cached snapshot.
    #[must_use]
    pub(crate) fn active_profile_id(&self) -> Option<i64> {
        self.node
            .as_ref()
            .and_then(|n| n.profile.as_ref().map(|p| p.id))
            .or(self.snapshot.profile_id)
    }

    /// Persists the local sync snapshot to disk if a config path is available.
    pub(crate) fn persist_snapshot(&self) {
        if let Some(path) = OrbitSyncSnapshot::default_path()
            && let Err(err) = self.snapshot.save_to(&path)
        {
            eprintln!("orbit sync: failed to save snapshot: {err}");
        }
    }

    /// Applies a completed fetch from the Orbit Gateway and returns an optional theme id to adopt
    /// (plus an optional `reduce_transparency` override from `devices.desktop`).
    pub(crate) fn apply_fetch(
        &mut self,
        result: OrbitFetchResult,
        current_appearance: Appearance,
        allow_theme_adopt: bool,
    ) -> OrbitAdoptEffects {
        self.node = Some(result.node.clone());
        self.profiles = result.profiles;

        let Some(profile) = result.node.profile else {
            self.status = OrbitSyncStatus::Unbound {
                node_name: result.node.name,
            };
            return OrbitAdoptEffects::default();
        };

        let mut effects = OrbitAdoptEffects::default();
        self.snapshot.profile_id = Some(profile.id);

        if let Some(settings) = result.settings {
            self.snapshot.profile_version = settings.version;

            if self.snapshot.prefs.sync_workspaces {
                self.workspaces = settings.workspaces.clone();
                self.snapshot.workspaces = settings.workspaces.clone();
            }

            if self.snapshot.prefs.sync_appearance
                && let Some(raw_app) = extract_section(&settings, APPEARANCE_SECTION)
            {
                let version = settings
                    .sections
                    .as_ref()
                    .and_then(|s| s.get(APPEARANCE_SECTION))
                    .map_or(0, |m| m.version);
                self.snapshot.appearance_version = version;
                self.snapshot.appearance_base = Some(raw_app.clone());
                if let Some(parsed) = parse_profile_appearance(&Value::Object(raw_app)) {
                    self.custom_themes = themes_from_profile_appearance(&parsed);
                    self.light_theme_id =
                        normalize_slot_theme_id(&parsed.themes.light, Appearance::Light);
                    self.dark_theme_id =
                        normalize_slot_theme_id(&parsed.themes.dark, Appearance::Dark);
                    if allow_theme_adopt {
                        let target_appearance = match parsed.mode {
                            ProfileAppearanceMode::Light => Appearance::Light,
                            ProfileAppearanceMode::Dark => Appearance::Dark,
                            ProfileAppearanceMode::System => current_appearance,
                        };
                        let slot_id = match target_appearance {
                            Appearance::Light => self.light_theme_id.clone(),
                            Appearance::Dark => self.dark_theme_id.clone(),
                        };
                        effects.theme_id = Some(slot_id);
                    }
                }
            }

            if self.snapshot.prefs.sync_desktop_settings
                && let Some(raw_desktop) = extract_section(&settings, DESKTOP_DEVICE_SECTION)
            {
                let version = settings
                    .sections
                    .as_ref()
                    .and_then(|s| s.get(DESKTOP_DEVICE_SECTION))
                    .map_or(0, |m| m.version);
                self.snapshot.desktop_version = version;
                self.snapshot.desktop_base = Some(raw_desktop.clone());
                if let Some(parsed) = parse_profile_device_section(&Value::Object(raw_desktop))
                    && let Some(glass) = parsed.values.get("glassOpacity").and_then(Value::as_f64)
                {
                    effects.reduce_transparency = Some(glass >= 0.99);
                }
            }
        }

        self.status = OrbitSyncStatus::Synced {
            node_name: result.node.name,
            profile_name: profile.name,
            workspace_count: self.workspaces.len(),
            custom_theme_count: self.custom_themes.len(),
        };
        self.persist_snapshot();
        effects
    }

    /// Builds an `appearance` section JSON document reflecting a user theme switch.
    #[must_use]
    pub(crate) fn build_appearance_document(
        &mut self,
        theme: &ThemeDefinition,
    ) -> Map<String, Value> {
        let mode = match theme.appearance {
            Appearance::Light => {
                self.light_theme_id = theme.id.clone();
                ProfileAppearanceMode::Light
            }
            Appearance::Dark => {
                self.dark_theme_id = theme.id.clone();
                ProfileAppearanceMode::Dark
            }
        };

        let mut base = self.snapshot.appearance_base.clone().unwrap_or_else(|| {
            let mut m = Map::new();
            m.insert("schema".into(), json!(PROFILE_SCHEMA_VERSION));
            m.insert("contrast".into(), json!(50));
            m.insert("customThemes".into(), json!([]));
            m
        });

        base.insert("schema".into(), json!(PROFILE_SCHEMA_VERSION));
        base.insert(
            "mode".into(),
            serde_json::to_value(mode).unwrap_or(json!("dark")),
        );
        if !base.contains_key("contrast") {
            base.insert("contrast".into(), json!(50));
        }
        if !base.contains_key("customThemes") {
            base.insert("customThemes".into(), json!([]));
        }

        let light_slot =
            theme_slot_for_id(&self.light_theme_id, Appearance::Light, &self.custom_themes);
        let dark_slot =
            theme_slot_for_id(&self.dark_theme_id, Appearance::Dark, &self.custom_themes);
        base.insert(
            "themes".into(),
            json!({
                "light": light_slot,
                "dark": dark_slot,
            }),
        );
        base
    }

    /// Builds a `devices.desktop` section document reflecting `reduce_transparency`.
    #[must_use]
    pub(crate) fn build_desktop_settings_document(
        &self,
        reduce_transparency: bool,
    ) -> Map<String, Value> {
        let mut section = self.snapshot.desktop_base.clone().unwrap_or_else(|| {
            let mut m = Map::new();
            m.insert("schema".into(), json!(PROFILE_SCHEMA_VERSION));
            m.insert("values".into(), json!({}));
            m
        });
        section.insert("schema".into(), json!(PROFILE_SCHEMA_VERSION));
        let values = section
            .entry("values".to_owned())
            .or_insert_with(|| Value::Object(Map::new()));
        if let Some(obj) = values.as_object_mut() {
            obj.insert(
                "glassOpacity".to_owned(),
                json!(if reduce_transparency { 1.0 } else { 0.72 }),
            );
        }
        section
    }
}

/// Optional UI mutations triggered when adopting a remote Orbit profile snapshot.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct OrbitAdoptEffects {
    pub(crate) theme_id: Option<String>,
    pub(crate) reduce_transparency: Option<bool>,
}

/// Returns true unless `CONN_GPUI_ORBIT_SYNC=0` explicitly opts out (e.g. deterministic captures).
#[must_use]
pub(crate) fn orbit_sync_enabled_by_env() -> bool {
    std::env::var("CONN_GPUI_ORBIT_SYNC")
        .map(|v| !matches!(v.trim(), "0" | "false" | "off" | "no"))
        .unwrap_or(true)
}

/// Returns true when the user did NOT pin an explicit theme via `CONN_GPUI_THEME` /
/// `CONN_GPUI_THEME_FILE`.
#[must_use]
pub(crate) fn allow_startup_theme_adopt() -> bool {
    std::env::var_os("CONN_GPUI_THEME").is_none()
        && std::env::var_os("CONN_GPUI_THEME_FILE").is_none()
}

/// Converts custom and resolved slot themes from a parsed [`ProfileAppearance`] into usable
/// [`ThemeDefinition`]s.
#[must_use]
pub(crate) fn themes_from_profile_appearance(
    appearance: &ProfileAppearance,
) -> Vec<ThemeDefinition> {
    let mut out: Vec<ThemeDefinition> = Vec::new();
    let mut push_unique = |def: ThemeDefinition| {
        if conn_theme::theme_by_id(&def.id).is_some() {
            return;
        }
        if let Some(existing) = out.iter_mut().find(|t| t.id == def.id) {
            *existing = def;
        } else {
            out.push(def);
        }
    };

    for custom in &appearance.custom_themes {
        let app = to_conn_appearance(custom.appearance);
        push_unique(theme_from_role_colors(
            custom.id.clone(),
            custom.name.clone(),
            app,
            &custom.colors,
        ));
    }

    for slot in [&appearance.themes.light, &appearance.themes.dark] {
        if let ProfileThemeSlot::Resolved {
            id,
            name,
            appearance: slot_app,
            colors,
            ..
        } = slot
        {
            push_unique(theme_from_role_colors(
                id.clone(),
                name.clone(),
                to_conn_appearance(*slot_app),
                colors,
            ));
        }
    }

    out
}

fn to_conn_appearance(app: ProfileThemeAppearance) -> Appearance {
    match app {
        ProfileThemeAppearance::Light => Appearance::Light,
        ProfileThemeAppearance::Dark => Appearance::Dark,
    }
}

fn to_profile_appearance(app: Appearance) -> ProfileThemeAppearance {
    match app {
        Appearance::Light => ProfileThemeAppearance::Light,
        Appearance::Dark => ProfileThemeAppearance::Dark,
    }
}

fn normalize_slot_theme_id(slot: &ProfileThemeSlot, appearance: Appearance) -> String {
    match slot {
        ProfileThemeSlot::Reference {
            source: ThemeSlotSource::Stock,
            ..
        } => match appearance {
            Appearance::Light => "t3-code-light".to_owned(),
            Appearance::Dark => "t3-code-dark".to_owned(),
        },
        other => {
            let id = other.id();
            if id == "t3-code" {
                match appearance {
                    Appearance::Light => "t3-code-light".to_owned(),
                    Appearance::Dark => "t3-code-dark".to_owned(),
                }
            } else {
                id.to_owned()
            }
        }
    }
}

fn theme_slot_for_id(
    theme_id: &str,
    appearance: Appearance,
    custom_themes: &[ThemeDefinition],
) -> ProfileThemeSlot {
    if theme_id == "t3-code-light" || theme_id == "t3-code-dark" || theme_id == "t3-code" {
        return ProfileThemeSlot::stock();
    }
    if conn_theme::theme_by_id(theme_id).is_some() {
        return ProfileThemeSlot::builtin(theme_id);
    }
    if let Some(custom) = custom_themes.iter().find(|t| t.id == theme_id) {
        let colors: BTreeMap<String, String> = custom
            .roles
            .iter()
            .map(|(k, rgba)| (k.clone(), rgba_to_hex(*rgba)))
            .collect();
        return ProfileThemeSlot::Resolved {
            id: custom.id.clone(),
            name: custom.name.clone(),
            source: ThemeSlotSource::Custom,
            appearance: to_profile_appearance(appearance),
            colors,
        };
    }
    ProfileThemeSlot::stock()
}

fn rgba_to_hex(rgba: Rgba) -> String {
    let r = (rgba.r.clamp(0.0, 1.0) * 255.0).round() as u8;
    let g = (rgba.g.clamp(0.0, 1.0) * 255.0).round() as u8;
    let b = (rgba.b.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{r:02x}{g:02x}{b:02x}")
}

/// Parses an Orbit workspace's `color` field (hex, rgb/oklch, or named Tailwind color) into an
/// [`Rgba`] swatch color with a sensible neutral fallback.
#[must_use]
pub(crate) fn workspace_tile_color(color: &str, fallback: Rgba) -> Rgba {
    let trimmed = color.trim();
    if let Ok(parsed) = conn_theme::parse_color(trimmed) {
        return parsed;
    }
    let hex = match trimmed.to_ascii_lowercase().as_str() {
        "red" | "rose" => Some(0xe11d48),
        "orange" | "amber" => Some(0xd97706),
        "yellow" => Some(0xca8a04),
        "lime" | "green" | "emerald" => Some(0x16a34a),
        "teal" | "cyan" => Some(0x0891b2),
        "sky" | "blue" => Some(0x2563eb),
        "indigo" => Some(0x4f46e5),
        "violet" | "purple" => Some(0x7c3aed),
        "fuchsia" | "pink" => Some(0xc026d3),
        "gray" | "slate" | "zinc" | "neutral" | "stone" => Some(0x52525b),
        _ => None,
    };
    hex.map(Rgba::hex).unwrap_or(fallback)
}

/// Returns crisp 1-2 character uppercase monogram initials for a workspace name.
#[must_use]
pub(crate) fn workspace_monogram(name: &str) -> String {
    let words: Vec<&str> = name
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect();
    match words.as_slice() {
        [] => "W".to_owned(),
        [single] => single
            .chars()
            .take(2)
            .collect::<String>()
            .to_ascii_uppercase(),
        [first, second, ..] => {
            let mut out = String::with_capacity(2);
            if let Some(c) = first.chars().next() {
                out.push(c.to_ascii_uppercase());
            }
            if let Some(c) = second.chars().next() {
                out.push(c.to_ascii_uppercase());
            }
            out
        }
    }
}

/// Fetches `/me`, `/profiles`, and (when bound) `/profiles/{id}/settings` from the live Gateway.
pub(crate) async fn fetch_orbit_profile() -> Result<OrbitFetchResult, ProfileError> {
    let client =
        OrbitProfileClient::live().map_err(|err| ProfileError::Unreachable(err.to_string()))?;
    let node = client.me().await?;
    let profiles = client.profiles().await.unwrap_or_default();
    let settings = match &node.profile {
        Some(profile) => Some(client.settings(profile.id).await?),
        None => None,
    };
    Ok(OrbitFetchResult {
        node,
        profiles,
        settings,
    })
}

/// Binds this Orbit Node to `profile_id` and immediately fetches the bound profile's settings.
pub(crate) async fn bind_and_fetch_orbit_profile(
    profile_id: i64,
) -> Result<OrbitFetchResult, ProfileError> {
    let client =
        OrbitProfileClient::live().map_err(|err| ProfileError::Unreachable(err.to_string()))?;
    let node = client.bind_profile(profile_id).await?;
    let profiles = client.profiles().await.unwrap_or_default();
    let settings = match &node.profile {
        Some(profile) => Some(client.settings(profile.id).await?),
        None => None,
    };
    Ok(OrbitFetchResult {
        node,
        profiles,
        settings,
    })
}

/// Pushes an updated `appearance` section to Orbit Gateway with 3-way conflict merge.
pub(crate) async fn push_appearance_section(
    profile_id: i64,
    base: Option<Map<String, Value>>,
    local: Map<String, Value>,
    version: i64,
) -> Result<OrbitProfileSettings, ProfileError> {
    let client =
        OrbitProfileClient::live().map_err(|err| ProfileError::Unreachable(err.to_string()))?;
    client
        .push_section_merged(
            profile_id,
            APPEARANCE_SECTION,
            base.as_ref(),
            &local,
            version,
            merge_appearance,
        )
        .await
}

/// Pushes an updated `devices.desktop` section to Orbit Gateway with 3-way conflict merge.
pub(crate) async fn push_desktop_section(
    profile_id: i64,
    base: Option<Map<String, Value>>,
    local: Map<String, Value>,
    version: i64,
) -> Result<OrbitProfileSettings, ProfileError> {
    let client =
        OrbitProfileClient::live().map_err(|err| ProfileError::Unreachable(err.to_string()))?;
    client
        .push_section_merged(
            profile_id,
            DESKTOP_DEVICE_SECTION,
            base.as_ref(),
            &local,
            version,
            merge_device_section,
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_monogram_uses_two_initials_or_prefix() {
        assert_eq!(workspace_monogram("Orbit Core"), "OC");
        assert_eq!(workspace_monogram("conn"), "CO");
        assert_eq!(workspace_monogram("   "), "W");
    }

    #[test]
    fn workspace_tile_color_parses_hex_and_named_palettes() {
        let fallback = Rgba::hex(0x000000);
        assert_eq!(
            workspace_tile_color("#3b82f6", fallback),
            Rgba::hex(0x3b82f6)
        );
        assert_eq!(
            workspace_tile_color("emerald", fallback),
            Rgba::hex(0x16a34a)
        );
        assert_eq!(workspace_tile_color("unknown", fallback), fallback);
    }
}
