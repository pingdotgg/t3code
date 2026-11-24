//! Saved appearance of native source editors.
use std::sync::{Arc, LazyLock};

use crate::theme::{MONO_FONT, hsla};
use conn_theme::{Appearance, Tokens};
use gpui_kit::component::{Theme, highlighter::HighlightTheme};
use gpui_kit::{App, Global, SharedString};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum Palette {
    #[default]
    One,
    Ayu,
    Gruvbox,
    TokyoNight,
    Catppuccin,
}

impl Palette {
    pub(crate) const ALL: [Self; 5] = [
        Self::One,
        Self::Ayu,
        Self::Gruvbox,
        Self::TokyoNight,
        Self::Catppuccin,
    ];

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::One => "One",
            Self::Ayu => "Ayu",
            Self::Gruvbox => "Gruvbox",
            Self::TokyoNight => "Tokyo Night",
            Self::Catppuccin => "Catppuccin",
        }
    }

    pub(crate) fn bytes(self) -> &'static [u8] {
        match self {
            Self::One => {
                include_bytes!("../assets/themes/one/one.json")
            }
            Self::Ayu => {
                include_bytes!("../assets/themes/ayu/ayu.json")
            }
            Self::Gruvbox => {
                include_bytes!("../assets/themes/gruvbox/gruvbox.json")
            }
            Self::TokyoNight => include_bytes!("../assets/themes/tokyo-night/tokyo-night.json"),
            Self::Catppuccin => include_bytes!("../assets/themes/catppuccin/catppuccin-mauve.json"),
        }
    }

    fn name(self, appearance: Appearance) -> &'static str {
        let (light, dark) = match self {
            Self::One => ("One Light", "One Dark"),
            Self::Ayu => ("Ayu Light", "Ayu Dark"),
            Self::Gruvbox => ("Gruvbox Light", "Gruvbox Dark"),
            Self::TokyoNight => ("Tokyo Night Light", "Tokyo Night"),
            Self::Catppuccin => ("Catppuccin Latte", "Catppuccin Mocha"),
        };
        if appearance == Appearance::Light {
            light
        } else {
            dark
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct Preferences {
    pub(crate) font_family: String,
    pub(crate) palette: Palette,
    pub(crate) font_size: f32,
    pub(crate) line_height: f32,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            font_family: String::new(),
            palette: Palette::default(),
            font_size: 15.0,
            line_height: 1.6,
        }
    }
}

impl Preferences {
    fn clamp_dimensions(&mut self) {
        self.font_size = self.font_size.clamp(8.0, 32.0);
        self.line_height = (self.line_height.clamp(1.0, 2.5) * 100.0).round() / 100.0;
    }
}

#[derive(Default)]
struct Store {
    prefs: Preferences,
    family: SharedString,
}
impl Global for Store {}

pub(crate) fn current(cx: &App) -> Preferences {
    cx.try_global::<Store>()
        .map(|s| s.prefs.clone())
        .unwrap_or_default()
}

pub(crate) fn family(cx: &App) -> SharedString {
    cx.try_global::<Store>()
        .map(|s| s.family.clone())
        .unwrap_or_else(|| MONO_FONT.into())
}

fn resolve_family(value: &str, cx: &App) -> SharedString {
    let value = value.trim();
    if value.is_empty() || value.eq_ignore_ascii_case(MONO_FONT) {
        return MONO_FONT.into();
    }
    cx.text_system()
        .all_font_names()
        .into_iter()
        .find(|name| name.eq_ignore_ascii_case(value))
        .map(Into::into)
        .unwrap_or_else(|| MONO_FONT.into())
}

pub(crate) fn init(cx: &mut App) {
    let mut prefs: Preferences = crate::terminal_settings::settings_path("editor-settings.json")
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default();
    prefs.clamp_dimensions();
    cx.set_global(Store {
        family: resolve_family(&prefs.font_family, cx),
        prefs,
    });
}

pub(crate) fn update(cx: &mut App, tokens: &Tokens, f: impl FnOnce(&mut Preferences)) {
    let previous = current(cx);
    let mut prefs = previous.clone();
    f(&mut prefs);
    prefs.clamp_dimensions();
    if prefs == previous {
        return;
    }
    if let Some(path) = crate::terminal_settings::settings_path("editor-settings.json")
        && let Ok(json) = serde_json::to_string_pretty(&prefs)
        && let Err(error) = crate::drafts::write_drafts_file(&path, &json)
    {
        eprintln!("Could not save editor settings: {error}");
    }
    let effective_family = resolve_family(&prefs.font_family, cx);
    let changed = effective_family != family(cx)
        || prefs.palette != previous.palette
        || prefs.font_size != previous.font_size
        || prefs.line_height != previous.line_height;
    cx.set_global(Store {
        family: effective_family,
        prefs,
    });
    if changed {
        apply(tokens, cx);
    }
    cx.refresh_windows();
}

pub(crate) fn apply(tokens: &Tokens, cx: &mut App) {
    #[derive(Deserialize)]
    struct Family {
        themes: Vec<HighlightTheme>,
    }
    static THEMES: LazyLock<Vec<HighlightTheme>> = LazyLock::new(|| {
        Palette::ALL
            .into_iter()
            .filter_map(|p| {
                serde_json::from_slice::<Family>(p.bytes())
                    .inspect_err(|error| {
                        eprintln!("Could not load {} editor theme: {error}", p.label())
                    })
                    .ok()
            })
            .flat_map(|family| family.themes)
            .collect()
    });
    let name = current(cx).palette.name(tokens.appearance);
    let bg = hsla(tokens.shell_card);
    if let Some(theme) = THEMES.iter().find(|t| t.name == name) {
        Theme::update(cx, |kit| {
            let mut theme = theme.clone();
            theme.style.editor_background = Some(bg);
            theme.style.editor_active_line = Some(bg);
            theme.style.editor_gutter_background = Some(bg);
            kit.highlight_theme = Arc::new(theme);
        });
    }
    #[cfg(feature = "zed-files")]
    crate::panels::zed_preview::apply(name, tokens, cx);
}
