//! Conn's icon set: superheroicons 16/solid (`assets/icons/superhero/`, copied from
//! `~/apps/superheroicons/consumers/conn/final`; see its `PROVENANCE.md`).
//!
//! Conn desktop and web draw every icon from this set (decision `conn-icon-set-solid-v4`).
//! Views ask for icons two ways, and both resolve here:
//! - `superhero/<concept>.svg`: a concept by name, such as `superhero/thinking.svg`.
//! - `icons/<lucide-name>.svg`: gpui-kit's Lucide paths (`IconName::PanelLeft`, and the icons
//!   inside kit components). The library manifest maps each Lucide name to its concept; the
//!   few names it lacks are mapped in [`EXTRA_LUCIDE`]. An unmapped name falls back to Lucide.
//!
//! Never edit the SVGs here. Glyph fixes go to the superheroicons library, then re-copy.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::LazyLock;

use gpui_kit::{AssetSource, Result, SharedString};
use rust_embed::RustEmbed;

/// The 16/solid drawings, served as `superhero/<concept>.svg`.
#[derive(RustEmbed)]
#[folder = "assets/icons/superhero/16/solid"]
#[prefix = "superhero/"]
#[include = "*.svg"]
struct Drawings;

/// Provider brand marks Conn shows next to provider names, served as `brand/<name>.{svg,png}`.
#[derive(RustEmbed)]
#[folder = "assets/icons/brand"]
#[prefix = "brand/"]
#[include = "*.svg"]
#[include = "*.png"]
struct Brands;

/// File-type icons Conn shows in the Files tree, file tabs, and chips, served as `files/<name>.svg`.
#[derive(RustEmbed)]
#[folder = "assets/icons/files"]
#[prefix = "files/"]
#[include = "*.svg"]
struct FileIcons;

/// Lucide names gpui-conn uses that the Conn manifest does not list.
const EXTRA_LUCIDE: &[(&str, &str)] = &[
    ("git-pull-request", "pull-request"),
    ("square-terminal", "terminal-window"),
    ("shield-alert", "needs-approval"),
];

/// `PanelLeftClose` → `panel-left-close`, `Trash2` → `trash-2` (Lucide's file names).
fn kebab(pascal: &str) -> String {
    let mut out = String::with_capacity(pascal.len() + 4);
    let mut prev: Option<char> = None;
    for c in pascal.chars() {
        let boundary = match prev {
            Some(p) => {
                (c.is_ascii_uppercase() && (p.is_ascii_lowercase() || p.is_ascii_digit()))
                    || (c.is_ascii_digit() && p.is_ascii_alphabetic())
            }
            None => false,
        };
        if boundary {
            out.push('-');
        }
        out.push(c.to_ascii_lowercase());
        prev = Some(c);
    }
    out
}

/// Lucide file name (kebab case) → concept.
static LUCIDE_TO_CONCEPT: LazyLock<HashMap<String, String>> = LazyLock::new(|| {
    let manifest: serde_json::Value =
        serde_json::from_str(include_str!("../assets/icons/superhero/manifest.json"))
            .unwrap_or_default();
    let mut map: HashMap<String, String> = manifest
        .get("lucide")
        .and_then(serde_json::Value::as_object)
        .map(|lucide| {
            lucide
                .iter()
                .filter_map(|(name, concept)| Some((kebab(name), concept.as_str()?.to_owned())))
                .collect()
        })
        .unwrap_or_default();
    for (name, concept) in EXTRA_LUCIDE {
        map.entry((*name).to_owned())
            .or_insert_with(|| (*concept).to_owned());
    }
    map
});

/// The superheroicons path for an asset path, if it is an icon the set draws.
fn resolve(path: &str) -> Option<String> {
    if path.starts_with("superhero/") {
        return Some(path.to_owned());
    }
    let name = path.strip_prefix("icons/")?.strip_suffix(".svg")?;
    let concept = LUCIDE_TO_CONCEPT.get(name)?;
    Some(format!("superhero/{concept}.svg"))
}

/// The app's assets: superheroicons first, then gpui-kit's own (fonts, unmapped Lucide).
#[derive(Debug)]
pub(crate) struct AppAssets;

impl AssetSource for AppAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        if let Some(file) = resolve(path).and_then(|p| Drawings::get(&p)) {
            return Ok(Some(file.data));
        }
        if let Some(file) = Brands::get(path) {
            return Ok(Some(file.data));
        }
        if let Some(file) = FileIcons::get(path) {
            return Ok(Some(file.data));
        }
        gpui_kit::assets::AllAssets.load(path)
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let mut out: Vec<SharedString> = Drawings::iter()
            .chain(Brands::iter())
            .chain(FileIcons::iter())
            .filter(|name| name.starts_with(path))
            .map(SharedString::from)
            .collect();
        out.extend(gpui_kit::assets::AllAssets.list(path)?);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kebab_matches_lucide_file_names() {
        assert_eq!(kebab("PanelLeftClose"), "panel-left-close", "words");
        assert_eq!(kebab("Trash2"), "trash-2", "digits");
        assert_eq!(kebab("X"), "x", "single letter");
        assert_eq!(kebab("ChartNoAxesColumn"), "chart-no-axes-column", "long");
    }

    #[test]
    fn every_icon_the_app_uses_resolves_to_a_drawing() {
        for name in [
            "globe",
            "folder",
            "search",
            "chevron-right",
            "terminal",
            "smartphone",
            "settings",
            "plus",
            "plug",
            "panel-right",
            "panel-left",
            "palette",
            "git-pull-request",
            "file-diff",
            "database",
            "chevron-down",
            "x",
            "webhook",
            "square-terminal",
            "square-pen",
            "sparkles",
            "sliders-horizontal",
            "shield-alert",
            "rotate-cw",
            "refresh-cw",
            "panel-left-close",
            "message-square",
            "list-filter",
            "layers",
            "keyboard",
            "folder-plus",
            "folder-open",
            "file",
            "cpu",
            "circle-dashed",
            "circle-alert",
            "chevron-left",
            "check",
            "chart-no-axes-column",
            "bot",
        ] {
            let path = resolve(&format!("icons/{name}.svg"));
            assert!(
                path.as_deref().and_then(Drawings::get).is_some(),
                "icons/{name}.svg has no superheroicons drawing ({path:?})"
            );
        }
    }

    #[test]
    fn unmapped_names_fall_back() {
        assert_eq!(
            resolve("icons/not-a-real-icon.svg"),
            None,
            "falls back to Lucide"
        );
        assert_eq!(resolve("fonts/x.ttf"), None, "non-icons untouched");
    }
}
