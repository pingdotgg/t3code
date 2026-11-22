//! Built-in Conn themes and JSON theme file parsing.

use std::collections::BTreeMap;

use serde::Deserialize;

use crate::color::parse_color;
use crate::palette_data::{
    EMBER_DARK_ROLES, EMBER_LIGHT_ROLES, GROVE_DARK_ROLES, GROVE_LIGHT_ROLES, IRIS_DARK_ROLES,
    IRIS_LIGHT_ROLES, OCEAN_DARK_ROLES, OCEAN_LIGHT_ROLES, T3_CHAT_DARK_ROLES, T3_CHAT_LIGHT_ROLES,
    T3_CODE_DARK_ROLES, T3_CODE_LIGHT_ROLES,
};
use crate::{Appearance, Rgba, ThemeDefinition, ThemeError};

const DARK_OCEAN_JSON: &str = include_str!("../themes/dark-ocean.json");
/// Nick's current dark theme (Orbit profile "Nick", as the Conn UI lab seeds it).
const DARK_MONO_JSON: &str = include_str!("../themes/dark-mono.json");

#[derive(Deserialize)]
struct RawThemeFile {
    name: String,
    appearance: Appearance,
    #[serde(default)]
    colors: BTreeMap<String, String>,
}

/// Parses a Conn custom theme JSON file into a [`ThemeDefinition`].
///
/// Missing roles fall back to the default palette for the theme's [`Appearance`]
/// (T3 Chat Light for light themes, T3 Chat Dark for dark themes), matching
/// `getDefaultThemeColors` in `apps/web/src/themePalette.ts`.
///
/// The legacy key `terminalSelectionBackground` (present in e.g. `dark-ocean.json`)
/// is normalized to `terminalSelection` when `terminalSelection` is not explicitly set.
///
/// # Errors
/// Returns [`ThemeError::Json`] if `json` is malformed or missing required fields, or
/// [`ThemeError::Color`] if any role value fails CSS color parsing.
pub fn parse_theme_json(id: &str, json: &str) -> Result<ThemeDefinition, ThemeError> {
    let raw: RawThemeFile = serde_json::from_str(json)?;
    let mut roles = default_roles_for_appearance(raw.appearance);

    let has_terminal_selection = raw.colors.contains_key("terminalSelection");
    for (role, value) in raw.colors {
        let parsed = parse_color(&value).map_err(|_| ThemeError::Color {
            role: role.clone(),
            value,
        })?;
        if role == "terminalSelectionBackground" {
            if !has_terminal_selection {
                roles.insert("terminalSelection".to_owned(), parsed);
            }
            continue;
        }
        roles.insert(role, parsed);
    }

    Ok(ThemeDefinition {
        id: id.to_owned(),
        name: raw.name.trim().to_owned(),
        appearance: raw.appearance,
        roles,
    })
}

/// Builds a [`ThemeDefinition`] from a raw CSS color role map (such as a custom or published
/// theme synced from an Orbit profile's `appearance` section).
///
/// Missing roles fall back to the default palette for `appearance`, and unparseable values are
/// skipped leniently (matching Conn's `lenientThemeColorOverrides`) so one malformed color from
/// another client never drops the whole theme.
#[must_use]
pub fn theme_from_role_colors(
    id: impl Into<String>,
    name: impl Into<String>,
    appearance: Appearance,
    colors: &BTreeMap<String, String>,
) -> ThemeDefinition {
    let mut roles = default_roles_for_appearance(appearance);
    let has_terminal_selection = colors.contains_key("terminalSelection");
    for (role, value) in colors {
        let Ok(parsed) = parse_color(value) else {
            continue;
        };
        if role == "terminalSelectionBackground" {
            if !has_terminal_selection {
                roles.insert("terminalSelection".to_owned(), parsed);
            }
            continue;
        }
        roles.insert(role.clone(), parsed);
    }
    let name = name.into();
    let trimmed = name.trim();
    let id = id.into();
    let display_name = if trimmed.is_empty() {
        id.clone()
    } else {
        trimmed.to_owned()
    };
    ThemeDefinition {
        id,
        name: display_name,
        appearance,
        roles,
    }
}

/// Default fallback role map for `appearance`, matching `getDefaultThemeColors` in
/// `apps/web/src/themePalette.ts`.
pub(crate) fn default_roles_for_appearance(appearance: Appearance) -> BTreeMap<String, Rgba> {
    let table = match appearance {
        Appearance::Light => T3_CHAT_LIGHT_ROLES,
        Appearance::Dark => T3_CHAT_DARK_ROLES,
    };
    parse_static_roles(table)
}

/// Every built-in theme: Dark Mono (Nick's default dark), Dark Ocean, T3 Code Light, then the rest.
#[must_use]
pub fn builtin_themes() -> Vec<ThemeDefinition> {
    let mut themes = Vec::with_capacity(14);

    if let Ok(dark_mono) = parse_theme_json("dark-mono", DARK_MONO_JSON) {
        themes.push(dark_mono);
    }
    if let Ok(dark_ocean) = parse_theme_json("dark-ocean", DARK_OCEAN_JSON) {
        themes.push(dark_ocean);
    }

    let static_themes: &[(&str, &str, Appearance, &[(&str, &str)])] = &[
        (
            "t3-code-light",
            "T3 Code Light",
            Appearance::Light,
            T3_CODE_LIGHT_ROLES,
        ),
        (
            "t3-code-dark",
            "T3 Code Dark",
            Appearance::Dark,
            T3_CODE_DARK_ROLES,
        ),
        ("t3-chat", "T3 Chat", Appearance::Light, T3_CHAT_LIGHT_ROLES),
        (
            "t3-chat-dark",
            "T3 Chat Dark",
            Appearance::Dark,
            T3_CHAT_DARK_ROLES,
        ),
        ("grove", "Grove", Appearance::Light, GROVE_LIGHT_ROLES),
        (
            "grove-dark",
            "Grove Dark",
            Appearance::Dark,
            GROVE_DARK_ROLES,
        ),
        ("ocean", "Ocean", Appearance::Light, OCEAN_LIGHT_ROLES),
        (
            "ocean-dark",
            "Ocean Dark",
            Appearance::Dark,
            OCEAN_DARK_ROLES,
        ),
        ("ember", "Ember", Appearance::Light, EMBER_LIGHT_ROLES),
        (
            "ember-dark",
            "Ember Dark",
            Appearance::Dark,
            EMBER_DARK_ROLES,
        ),
        ("iris", "Iris", Appearance::Light, IRIS_LIGHT_ROLES),
        ("iris-dark", "Iris Dark", Appearance::Dark, IRIS_DARK_ROLES),
    ];

    for &(id, name, appearance, table) in static_themes {
        themes.push(ThemeDefinition {
            id: id.to_owned(),
            name: name.to_owned(),
            appearance,
            roles: parse_static_roles(table),
        });
    }

    themes
}

fn parse_static_roles(table: &[(&str, &str)]) -> BTreeMap<String, Rgba> {
    let mut roles = BTreeMap::new();
    for &(key, value) in table {
        if let Ok(color) = parse_color(value) {
            roles.insert(key.to_owned(), color);
        }
    }
    roles
}
