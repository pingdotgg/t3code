//! Orbit Nodes, Instances, profile, workspace, theme, and desktop settings sync controller.
//!
//! Bridges [`conn_desktop::orbit::OrbitProfileClient`] and [`conn_desktop::orbit::OrbitFleetClient`]
//! (running on [`crate::live::RT`]) with [`crate::app::ConnApp`]'s UI state, active server
//! switching, workspace rail, custom theme catalog, Command Palette (`⌘K`), and Settings modal.

use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use conn_desktop::orbit::{
    APPEARANCE_SECTION, DESKTOP_DEVICE_SECTION, OrbitFleet, OrbitFleetClient, OrbitNode,
    OrbitPairingTicket, OrbitProfile, OrbitProfileClient, OrbitProfileSettings, OrbitSessionStore,
    OrbitSyncPrefs, OrbitSyncSnapshot, OrbitWorkspace, PROFILE_SCHEMA_VERSION, ProfileAppearance,
    ProfileAppearanceMode, ProfileError, ProfileThemeAppearance, ProfileThemeSlot, SectionMeta,
    SectionPatch, ThemeSlotSource, extract_section, merge_appearance, merge_device_section,
    parse_profile_appearance, parse_profile_device_section, to_gateway_form,
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
        wireguard_ip: String,
        profile_name: String,
        profile_version: i64,
        workspace_count: usize,
        custom_theme_count: usize,
    },
    Unbound {
        node_name: String,
        wireguard_ip: String,
    },
    Offline(String),
}

/// Snapshot of Orbit Nodes, Instances, and profile sync state displayed inside Settings → Connections.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct OrbitSettingsInfo {
    pub(crate) status: OrbitSyncStatus,
    pub(crate) local_node_name: Option<String>,
    pub(crate) active_profile_id: Option<i64>,
    pub(crate) profiles: Vec<OrbitProfile>,
    pub(crate) prefs: OrbitSyncPrefs,
    pub(crate) fleet: OrbitFleet,
    /// Gateway `server_id` of the currently connected Node or Instance (when connected via Orbit).
    pub(crate) active_server_id: Option<String>,
    /// Gateway `server_id` currently pairing/connecting.
    pub(crate) connecting_server_id: Option<String>,
    /// Orbit `instance_id` currently waking.
    pub(crate) waking_instance_id: Option<i64>,
    /// Paired `server_id`s that already have a cached local bearer token.
    pub(crate) paired_server_ids: Vec<String>,
    /// Section attribution lines (e.g. `"Appearance: changed by beast"`).
    pub(crate) section_changes: Vec<String>,
    /// True when a local backup exists before a "Use the profile" pull.
    pub(crate) has_backup: bool,
    /// Optional status/error banner shown in the Orbit section.
    pub(crate) notice: Option<String>,
}

/// Full result returned by a background Orbit Gateway sync fetch.
#[derive(Clone, Debug)]
pub(crate) struct OrbitFetchResult {
    pub(crate) node: OrbitNode,
    pub(crate) profiles: Vec<OrbitProfile>,
    pub(crate) settings: Option<OrbitProfileSettings>,
    pub(crate) fleet: OrbitFleet,
}

/// App-owned Orbit Nodes/Instances + profile sync state.
#[derive(Clone, Debug)]
pub(crate) struct OrbitSyncState {
    pub(crate) status: OrbitSyncStatus,
    pub(crate) node: Option<OrbitNode>,
    pub(crate) profiles: Vec<OrbitProfile>,
    pub(crate) fleet: OrbitFleet,
    pub(crate) sessions: OrbitSessionStore,
    pub(crate) active_server_id: Option<String>,
    pub(crate) connecting_server_id: Option<String>,
    pub(crate) waking_instance_id: Option<i64>,
    pub(crate) notice: Option<String>,
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
        let sessions = OrbitSessionStore::load_default();
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
            fleet: OrbitFleet::default(),
            sessions,
            active_server_id: None,
            connecting_server_id: None,
            waking_instance_id: None,
            notice: None,
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
    pub(crate) fn settings_info(&self, connected_server_url: Option<&str>) -> OrbitSettingsInfo {
        let active_server_id = self.active_server_id.clone().or_else(|| {
            connected_server_url
                .and_then(|url| self.fleet.find_by_url(url))
                .map(|target| target.server_id.clone())
        });
        let mut section_changes = Vec::new();
        if let Some(line) =
            format_section_change("Appearance", self.snapshot.appearance_meta.as_ref())
        {
            section_changes.push(line);
        }
        if let Some(line) =
            format_section_change("Desktop settings", self.snapshot.desktop_meta.as_ref())
        {
            section_changes.push(line);
        }
        let has_backup =
            self.snapshot.appearance_backup.is_some() || self.snapshot.desktop_backup.is_some();

        OrbitSettingsInfo {
            status: self.status.clone(),
            local_node_name: self.node.as_ref().map(|n| n.name.clone()),
            active_profile_id: self.active_profile_id(),
            profiles: self.profiles.clone(),
            prefs: self.snapshot.prefs.clone(),
            fleet: self.fleet.clone(),
            active_server_id,
            connecting_server_id: self.connecting_server_id.clone(),
            waking_instance_id: self.waking_instance_id,
            paired_server_ids: self.sessions.sessions.keys().cloned().collect(),
            section_changes,
            has_backup,
            notice: self.notice.clone(),
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

    /// Persists the local profile sync snapshot to disk if a config path is available.
    pub(crate) fn persist_snapshot(&self) {
        if let Some(path) = OrbitSyncSnapshot::default_path()
            && let Err(err) = self.snapshot.save_to(&path)
        {
            eprintln!("orbit sync: failed to save snapshot: {err}");
        }
    }

    /// Persists the local Orbit Node/Instance bearer session cache to disk (`0600`).
    pub(crate) fn persist_sessions(&self) {
        if let Err(err) = self.sessions.save_default() {
            eprintln!("orbit sync: failed to save sessions: {err}");
        }
    }

    /// Saves a local backup of current appearance + desktop settings before a forced pull.
    pub(crate) fn backup_local_sections(
        &mut self,
        current_theme: Option<&ThemeDefinition>,
        reduce_transparency: bool,
    ) {
        if let Some(theme) = current_theme {
            self.snapshot.appearance_backup = Some(self.build_appearance_document(theme));
        }
        self.snapshot.desktop_backup =
            Some(self.build_desktop_settings_document(reduce_transparency));
        self.snapshot.backup_saved_at_unix = Some(now_unix_secs());
        self.persist_snapshot();
    }

    /// Restores the last local backup (returning theme + reduce_transparency effects and the
    /// raw backup documents to push back to Orbit).
    pub(crate) fn take_backup_restore(
        &mut self,
        current_appearance: Appearance,
    ) -> Option<(
        OrbitAdoptEffects,
        Option<Map<String, Value>>,
        Option<Map<String, Value>>,
    )> {
        let app_backup = self.snapshot.appearance_backup.take();
        let desktop_backup = self.snapshot.desktop_backup.take();
        self.snapshot.backup_saved_at_unix = None;
        if app_backup.is_none() && desktop_backup.is_none() {
            return None;
        }
        let mut effects = OrbitAdoptEffects::default();
        if let Some(raw_app) = &app_backup
            && let Some(parsed) = parse_profile_appearance(&Value::Object(raw_app.clone()))
        {
            self.custom_themes = themes_from_profile_appearance(&parsed);
            self.light_theme_id = normalize_slot_theme_id(&parsed.themes.light, Appearance::Light);
            self.dark_theme_id = normalize_slot_theme_id(&parsed.themes.dark, Appearance::Dark);
            let target_app = match parsed.mode {
                ProfileAppearanceMode::Light => Appearance::Light,
                ProfileAppearanceMode::Dark => Appearance::Dark,
                ProfileAppearanceMode::System => current_appearance,
            };
            effects.theme_id = Some(match target_app {
                Appearance::Light => self.light_theme_id.clone(),
                Appearance::Dark => self.dark_theme_id.clone(),
            });
        }
        if let Some(raw_desktop) = &desktop_backup
            && let Some(parsed) = parse_profile_device_section(&Value::Object(raw_desktop.clone()))
            && let Some(glass) = parsed.values.get("glassOpacity").and_then(Value::as_f64)
        {
            effects.reduce_transparency = Some(glass >= 0.99);
        }
        self.persist_snapshot();
        Some((effects, app_backup, desktop_backup))
    }

    /// Applies a completed fetch from the Orbit Gateway and returns optional UI adopt effects.
    pub(crate) fn apply_fetch(
        &mut self,
        result: OrbitFetchResult,
        current_appearance: Appearance,
        allow_theme_adopt: bool,
    ) -> OrbitAdoptEffects {
        self.node = Some(result.node.clone());
        self.profiles = result.profiles;
        self.fleet = result.fleet;

        let Some(profile) = result.node.profile else {
            self.status = OrbitSyncStatus::Unbound {
                node_name: result.node.name,
                wireguard_ip: result.node.wireguard_ip,
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
                let meta = settings
                    .sections
                    .as_ref()
                    .and_then(|s| s.get(APPEARANCE_SECTION))
                    .cloned();
                self.snapshot.appearance_version = meta.as_ref().map_or(0, |m| m.version);
                self.snapshot.appearance_meta = meta;
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
                let meta = settings
                    .sections
                    .as_ref()
                    .and_then(|s| s.get(DESKTOP_DEVICE_SECTION))
                    .cloned();
                self.snapshot.desktop_version = meta.as_ref().map_or(0, |m| m.version);
                self.snapshot.desktop_meta = meta;
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
            wireguard_ip: result.node.wireguard_ip,
            profile_name: profile.name,
            profile_version: self.snapshot.profile_version,
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

/// Returns true unless `CONN_GPUI_ORBIT_SYNC=0` explicitly opts out, or the app is running
/// under `CONN_GPUI_AUTOMATION` (where live profile sync defaults off unless explicitly opted in).
#[must_use]
pub(crate) fn orbit_sync_enabled_by_env() -> bool {
    if cfg!(test) {
        return false;
    }
    if let Ok(val) = std::env::var("CONN_GPUI_ORBIT_SYNC") {
        return !matches!(val.trim(), "0" | "false" | "off" | "no");
    }
    std::env::var_os("CONN_GPUI_AUTOMATION").is_none()
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

fn format_section_change(label: &str, meta: Option<&SectionMeta>) -> Option<String> {
    let meta = meta?;
    if meta.version <= 0 {
        return None;
    }
    let by = meta
        .updated_by
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|who| format!(" by {who}"))
        .unwrap_or_default();
    let when = meta
        .updated_at
        .as_deref()
        .and_then(|ts| ts.get(..16))
        .map(|ts| format!(" ({})", ts.replace('T', " ")))
        .unwrap_or_default();
    Some(format!("{label}: v{}{by}{when}", meta.version))
}

fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
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

/// Fetches `/me`, `/profiles`, `/profiles/{id}/settings`, and the Orbit Nodes & Instances fleet.
pub(crate) async fn fetch_orbit_profile() -> Result<OrbitFetchResult, ProfileError> {
    let client =
        OrbitProfileClient::live().map_err(|err| ProfileError::Unreachable(err.to_string()))?;
    let fleet_client =
        OrbitFleetClient::live().map_err(|err| ProfileError::Unreachable(err.to_string()))?;
    let node = client.me().await?;
    let profiles = client.profiles().await.unwrap_or_default();
    let settings = match &node.profile {
        Some(profile) => Some(client.settings(profile.id).await?),
        None => None,
    };
    let fleet = fleet_client
        .list_fleet(Some(&node.name))
        .await
        .unwrap_or_default();
    Ok(OrbitFetchResult {
        node,
        profiles,
        settings,
        fleet,
    })
}

/// Binds this Orbit Node to `profile_id` and immediately fetches the bound profile + fleet.
pub(crate) async fn bind_and_fetch_orbit_profile(
    profile_id: i64,
) -> Result<OrbitFetchResult, ProfileError> {
    let client =
        OrbitProfileClient::live().map_err(|err| ProfileError::Unreachable(err.to_string()))?;
    let fleet_client =
        OrbitFleetClient::live().map_err(|err| ProfileError::Unreachable(err.to_string()))?;
    let node = client.bind_profile(profile_id).await?;
    let profiles = client.profiles().await.unwrap_or_default();
    let settings = match &node.profile {
        Some(profile) => Some(client.settings(profile.id).await?),
        None => None,
    };
    let fleet = fleet_client
        .list_fleet(Some(&node.name))
        .await
        .unwrap_or_default();
    Ok(OrbitFetchResult {
        node,
        profiles,
        settings,
        fleet,
    })
}

/// Creates a new Orbit profile (`POST /profiles`), binds this Node to it, and fetches state.
pub(crate) async fn create_and_bind_orbit_profile(
    name: String,
) -> Result<OrbitFetchResult, ProfileError> {
    let client =
        OrbitProfileClient::live().map_err(|err| ProfileError::Unreachable(err.to_string()))?;
    let created = client.create_profile(name.trim()).await?;
    bind_and_fetch_orbit_profile(created.id).await
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

/// Force-pushes the local `appearance` and/or `devices.desktop` sections to replace the profile's
/// values ("Use this device" / "Restore previous settings").
pub(crate) async fn force_push_profile_sections(
    profile_id: i64,
    appearance: Option<Map<String, Value>>,
    desktop: Option<Map<String, Value>>,
) -> Result<OrbitProfileSettings, ProfileError> {
    let client =
        OrbitProfileClient::live().map_err(|err| ProfileError::Unreachable(err.to_string()))?;
    let latest = client.settings(profile_id).await?;
    let mut patches = BTreeMap::new();
    if let Some(app_doc) = appearance {
        let ver = latest
            .sections
            .as_ref()
            .and_then(|s| s.get(APPEARANCE_SECTION))
            .map_or(0, |m| m.version);
        patches.insert(
            APPEARANCE_SECTION.to_owned(),
            SectionPatch {
                version: ver,
                value: Some(to_gateway_form(&app_doc)),
            },
        );
    }
    if let Some(desk_doc) = desktop {
        let ver = latest
            .sections
            .as_ref()
            .and_then(|s| s.get(DESKTOP_DEVICE_SECTION))
            .map_or(0, |m| m.version);
        patches.insert(
            DESKTOP_DEVICE_SECTION.to_owned(),
            SectionPatch {
                version: ver,
                value: Some(to_gateway_form(&desk_doc)),
            },
        );
    }
    if patches.is_empty() {
        return Ok(latest);
    }
    client.patch_sections(profile_id, &patches).await
}

/// Mints a one-time pairing URL for an Orbit Node or Instance.
pub(crate) async fn mint_orbit_pairing(
    server_id: String,
) -> Result<OrbitPairingTicket, ProfileError> {
    let client =
        OrbitFleetClient::live().map_err(|err| ProfileError::Unreachable(err.to_string()))?;
    client.mint_pairing(&server_id).await
}

/// Refreshes only the Orbit Nodes & Instances fleet from `gateway.orbit` (called on Reverb
/// `FleetChanged` notices so waking/stopping Instances updates live without polling).
pub(crate) async fn fetch_orbit_fleet(
    local_node_name: Option<String>,
) -> Result<OrbitFleet, ProfileError> {
    let client =
        OrbitFleetClient::live().map_err(|err| ProfileError::Unreachable(err.to_string()))?;
    client.list_fleet(local_node_name.as_deref()).await
}

/// Requests Orbit to wake a stopped Instance (`POST /api/v1/instances/{id}/wake`).
pub(crate) async fn wake_orbit_instance(instance_id: i64) -> Result<Option<i64>, ProfileError> {
    let client =
        OrbitFleetClient::live().map_err(|err| ProfileError::Unreachable(err.to_string()))?;
    client.wake_instance(instance_id).await
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
