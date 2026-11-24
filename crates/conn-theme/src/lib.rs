#![forbid(unsafe_code)]

//! Conn theme palettes and `nckrtl-shell-design` token derivation.
//!
//! Mirrors `packages/shared/src/themePalettes.ts` and the shell token formulas in
//! `apps/web/src/index.css` (summarized in `docs/design-spec.md`).
//!
//! This crate is GPUI-free. `conn-app` converts [`Rgba`] into GPUI colors.
//!
//! API contract (other crates build against these names; keep them stable):
//! - [`Rgba`]: straight-alpha sRGB, every channel `0.0..=1.0`.
//! - [`ThemeDefinition`]: one theme's id, name, appearance, and color roles.
//! - [`builtin_themes`], [`theme_by_id`], [`parse_theme_json`].
//! - [`Tokens::derive`]: every semantic and shell token the views paint with.

mod color;
mod palette_data;
mod palettes;
mod tokens;

use std::collections::BTreeMap;

pub use color::{ParseColorError, color_mix_oklab, color_mix_srgb, parse_color};
pub use palettes::{builtin_themes, parse_theme_json, theme_from_role_colors};

/// Light or dark theme appearance.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    Light,
    Dark,
}

/// A straight-alpha sRGB color. Channels are `0.0..=1.0`.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Rgba {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl Rgba {
    pub const TRANSPARENT: Self = Self::new(0.0, 0.0, 0.0, 0.0);

    #[must_use]
    pub const fn new(r: f32, g: f32, b: f32, a: f32) -> Self {
        Self { r, g, b, a }
    }

    /// `0xRRGGBB`, opaque.
    #[must_use]
    pub fn hex(rgb: u32) -> Self {
        let [_, r, g, b] = rgb.to_be_bytes();
        Self::new(
            f32::from(r) / 255.0,
            f32::from(g) / 255.0,
            f32::from(b) / 255.0,
            1.0,
        )
    }

    /// The same color at `alpha` (replaces, does not multiply).
    #[must_use]
    pub const fn with_alpha(self, alpha: f32) -> Self {
        Self::new(self.r, self.g, self.b, alpha)
    }
}

/// Claude's brand orange, as Conn paints the Claude mark (`fill-[#d97757]`).
pub const CLAUDE_BRAND: Rgba = Rgba::new(
    0xd9 as f32 / 255.0,
    0x77 as f32 / 255.0,
    0x57 as f32 / 255.0,
    1.0,
);

/// Errors from loading a theme.
#[derive(Debug, thiserror::Error)]
pub enum ThemeError {
    #[error("invalid theme json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid color for role `{role}`: {value}")]
    Color { role: String, value: String },
}

/// One theme: its id, display name, appearance, and color roles.
///
/// Role keys use the camelCase names from `THEME_COLOR_ROLES` in
/// `packages/shared/src/themePalettes.ts` (`canvas`, `text`, `sidebar`, ...).
#[derive(Clone, Debug, PartialEq)]
pub struct ThemeDefinition {
    pub id: String,
    pub name: String,
    pub appearance: Appearance,
    pub roles: BTreeMap<String, Rgba>,
}

/// A built-in theme by id (`dark-mono`, `dark-ocean`, `t3-code-light`, `t3-code-dark`, ...).
#[must_use]
pub fn theme_by_id(id: &str) -> Option<ThemeDefinition> {
    builtin_themes().into_iter().find(|t| t.id == id)
}

/// Every color a view paints with, derived from one theme.
///
/// Field names follow the CSS custom properties (`--shell-divider-header` ->
/// `shell_divider_header`). Values match `index.css` for the macOS Electron shell
/// (`html.electron-macos`), including its translucent `shell_fill` and `shell_inner_fill`.
#[derive(Clone, Debug, PartialEq)]
pub struct Tokens {
    pub appearance: Appearance,
    // Base semantic roles (`--background`, `--foreground`, ...).
    pub background: Rgba,
    pub foreground: Rgba,
    pub card: Rgba,
    pub card_foreground: Rgba,
    pub popover: Rgba,
    pub popover_foreground: Rgba,
    pub primary: Rgba,
    pub primary_foreground: Rgba,
    pub secondary: Rgba,
    pub secondary_foreground: Rgba,
    pub muted: Rgba,
    pub muted_foreground: Rgba,
    pub accent: Rgba,
    pub accent_foreground: Rgba,
    pub border: Rgba,
    pub input: Rgba,
    pub ring: Rgba,
    pub placeholder: Rgba,
    pub destructive: Rgba,
    pub destructive_foreground: Rgba,
    pub warning: Rgba,
    pub warning_foreground: Rgba,
    pub info: Rgba,
    pub info_foreground: Rgba,
    pub success: Rgba,
    pub success_foreground: Rgba,
    pub sidebar: Rgba,
    pub sidebar_foreground: Rgba,
    pub sidebar_muted_foreground: Rgba,
    pub sidebar_border: Rgba,
    pub toolbar_control: Rgba,
    pub toolbar_control_hover: Rgba,
    pub code_background: Rgba,
    pub code_foreground: Rgba,
    pub terminal_background: Rgba,
    pub terminal_foreground: Rgba,
    pub terminal_cursor: Rgba,
    pub terminal_selection: Rgba,
    /// User chat bubble fill and text.
    pub message_surface: Rgba,
    pub message_foreground: Rgba,
    // Shell tokens (end of `index.css`).
    pub shell_fill: Rgba,
    pub shell_panel: Rgba,
    pub shell_card: Rgba,
    pub shell_inner_fill: Rgba,
    pub shell_inner_border: Rgba,
    pub shell_raised: Rgba,
    pub shell_overlay: Rgba,
    pub shell_highlight: Rgba,
    pub shell_tile: Rgba,
    pub shell_tile_border: Rgba,
    pub shell_field: Rgba,
    pub shell_control: Rgba,
    pub shell_control_raised: Rgba,
    pub shell_control_raised_border: Rgba,
    pub shell_divider: Rgba,
    pub shell_divider_header: Rgba,
    pub shell_divider_raised: Rgba,
    pub shell_settings_card: Rgba,
    pub shell_settings_card_border: Rgba,
    pub shell_header_control: Rgba,
    pub shell_header_control_hover: Rgba,
    pub glass_divider: Rgba,
    pub muted_foreground_raised: Rgba,
    pub switch_on: Rgba,
    pub sidebar_row_hover: Rgba,
    pub sidebar_row_selected: Rgba,
    pub sidebar_row_active: Rgba,
    // Diff colors.
    pub diff_added: Rgba,
    pub diff_added_background: Rgba,
    pub diff_removed: Rgba,
    pub diff_removed_background: Rgba,
}

impl Tokens {
    /// Derives every token from `theme` exactly as `index.css` does for `html.electron-macos`.
    #[must_use]
    pub fn derive(theme: &ThemeDefinition) -> Self {
        tokens::derive_tokens(theme)
    }
}

/// Core geometric constants from `nckrtl-shell-design` (DesignKit / ChatGPT-desktop shell).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShellGeometry {
    pub window_radius_px: f32,
    pub shell_inset_px: f32,
    pub shell_corner_px: f32,
    pub header_height_px: f32,
    pub workspace_controls_right_px: f32,
    pub ui_font_size_px: f32,
    pub ui_line_height_px: f32,
    pub toolbar_height_px: f32,
    pub bubble_radius_px: f32,
}

impl Default for ShellGeometry {
    fn default() -> Self {
        Self {
            window_radius_px: 18.0,
            shell_inset_px: 4.0,
            shell_corner_px: 14.0,
            header_height_px: 44.0,
            workspace_controls_right_px: 11.0,
            ui_font_size_px: 13.0,
            ui_line_height_px: 20.0,
            toolbar_height_px: 32.0,
            bubble_radius_px: 16.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn to_hex(c: Rgba) -> String {
        let r = (c.r * 255.0).round() as u8;
        let g = (c.g * 255.0).round() as u8;
        let b = (c.b * 255.0).round() as u8;
        format!("#{r:02x}{g:02x}{b:02x}")
    }

    fn assert_rgba_near(actual: Rgba, expected_hex: &str, expected_alpha: f32, label: &str) {
        let Ok(expected) = parse_color(expected_hex) else {
            panic!("invalid expected hex {expected_hex} for {label}");
        };
        let tol = 1.0 / 255.0 + 1e-4;
        assert!(
            (actual.r - expected.r).abs() <= tol
                && (actual.g - expected.g).abs() <= tol
                && (actual.b - expected.b).abs() <= tol,
            "{label}: expected {expected_hex}, got {} ({actual:?})",
            to_hex(actual)
        );
        assert!(
            (actual.a - expected_alpha).abs() <= 1e-4,
            "{label}: expected alpha {expected_alpha}, got {}",
            actual.a
        );
    }

    fn assert_unit_rgba(c: Rgba, label: &str) {
        assert!(
            (0.0..=1.0).contains(&c.r)
                && (0.0..=1.0).contains(&c.g)
                && (0.0..=1.0).contains(&c.b)
                && (0.0..=1.0).contains(&c.a),
            "{label}: channel out of 0..=1 range: {c:?}"
        );
    }

    #[test]
    fn parse_oklch_known_values() {
        // Independently verified with CSS Color 4 OKLCH->OKLab->linear sRGB->gamma sRGB formulas.
        let Ok(red_orange) = parse_color("oklch(0.6 0.2 30)") else {
            panic!("oklch(0.6 0.2 30) should parse");
        };
        assert_rgba_near(red_orange, "#de3e2d", 1.0, "oklch(0.6 0.2 30)");

        let Ok(white) = parse_color("oklch(1 0 0)") else {
            panic!("oklch(1 0 0) should parse");
        };
        assert_rgba_near(white, "#ffffff", 1.0, "oklch white");

        let Ok(black) = parse_color("oklch(0 0 0)") else {
            panic!("oklch(0 0 0) should parse");
        };
        assert_rgba_near(black, "#000000", 1.0, "oklch black");

        let Ok(with_alpha) = parse_color("oklch(99.2% 0 0 / 50%)") else {
            panic!("oklch with percent lightness and alpha should parse");
        };
        assert_rgba_near(with_alpha, "#fcfcfc", 0.5, "oklch(99.2% 0 0 / 50%)");
    }

    #[test]
    fn parse_hex_rgb_and_keywords() {
        let Ok(short_hex) = parse_color("#0f8") else {
            panic!("#0f8 should parse");
        };
        assert_rgba_near(short_hex, "#00ff88", 1.0, "#0f8");

        let Ok(hex_alpha) = parse_color("#11223380") else {
            panic!("#11223380 should parse");
        };
        assert_rgba_near(hex_alpha, "#112233", 128.0 / 255.0, "#11223380");

        let Ok(rgb_modern) = parse_color("rgb(255 255 255 / 8%)") else {
            panic!("modern rgb() should parse");
        };
        assert_rgba_near(rgb_modern, "#ffffff", 0.08, "rgb(255 255 255 / 8%)");

        let Ok(rgba_legacy) = parse_color("rgba(37, 63, 99, 0.2)") else {
            panic!("legacy rgba() should parse");
        };
        assert_rgba_near(rgba_legacy, "#253f63", 0.2, "rgba(37, 63, 99, 0.2)");

        let Ok(transp) = parse_color("transparent") else {
            panic!("transparent should parse");
        };
        assert_eq!(transp, Rgba::TRANSPARENT, "transparent keyword");
    }

    #[test]
    fn color_mix_srgb_and_oklab_rules() {
        // Mixing an opaque color with transparent keeps RGB and scales alpha.
        let red = Rgba::hex(0xff0000);
        let mixed_transp = color_mix_srgb(red, 0.60, Rgba::TRANSPARENT);
        assert_rgba_near(mixed_transp, "#ff0000", 0.60, "red 60% transparent");

        // sRGB 50/50 mix of black and white is #808080.
        let gray_srgb = color_mix_srgb(Rgba::hex(0x000000), 0.50, Rgba::hex(0xffffff));
        assert_rgba_near(gray_srgb, "#808080", 1.0, "srgb 50% black/white");

        // OKLab 50/50 mix of black (L=0) and white (L=1) has L=0.5 -> linear 0.125 -> sRGB ~0.3886 (#636363).
        let gray_oklab = color_mix_oklab(Rgba::hex(0x000000), 0.50, Rgba::hex(0xffffff));
        assert_rgba_near(gray_oklab, "#636363", 1.0, "oklab 50% black/white");

        // Premultiplied alpha: 50% of (red @ 0.5) and 50% of (blue @ 1.0) -> alpha_out = 0.75,
        // r = (0.25 * 1.0) / 0.75 = 1/3, b = (0.5 * 1.0) / 0.75 = 2/3.
        let premul = color_mix_srgb(red.with_alpha(0.5), 0.5, Rgba::hex(0x0000ff));
        assert_rgba_near(premul, "#5500aa", 0.75, "premultiplied srgb mix");
    }

    #[test]
    fn builtin_themes_order_and_validity() {
        let themes = builtin_themes();
        assert!(
            themes.len() >= 13,
            "expected at least 13 built-in themes, got {}",
            themes.len()
        );
        assert_eq!(themes[0].id, "dark-mono", "Dark Mono must be first");
        assert_eq!(themes[1].id, "dark-ocean", "Dark Ocean second");
        assert_eq!(themes[2].id, "t3-code-light", "T3 Code Light third");

        for theme in &themes {
            let tokens = Tokens::derive(theme);
            let all_colors = [
                ("background", tokens.background),
                ("foreground", tokens.foreground),
                ("card", tokens.card),
                ("card_foreground", tokens.card_foreground),
                ("popover", tokens.popover),
                ("popover_foreground", tokens.popover_foreground),
                ("primary", tokens.primary),
                ("primary_foreground", tokens.primary_foreground),
                ("secondary", tokens.secondary),
                ("secondary_foreground", tokens.secondary_foreground),
                ("muted", tokens.muted),
                ("muted_foreground", tokens.muted_foreground),
                ("accent", tokens.accent),
                ("accent_foreground", tokens.accent_foreground),
                ("border", tokens.border),
                ("input", tokens.input),
                ("ring", tokens.ring),
                ("placeholder", tokens.placeholder),
                ("destructive", tokens.destructive),
                ("destructive_foreground", tokens.destructive_foreground),
                ("warning", tokens.warning),
                ("warning_foreground", tokens.warning_foreground),
                ("info", tokens.info),
                ("info_foreground", tokens.info_foreground),
                ("success", tokens.success),
                ("success_foreground", tokens.success_foreground),
                ("sidebar", tokens.sidebar),
                ("sidebar_foreground", tokens.sidebar_foreground),
                ("sidebar_muted_foreground", tokens.sidebar_muted_foreground),
                ("sidebar_border", tokens.sidebar_border),
                ("toolbar_control", tokens.toolbar_control),
                ("toolbar_control_hover", tokens.toolbar_control_hover),
                ("code_background", tokens.code_background),
                ("code_foreground", tokens.code_foreground),
                ("terminal_background", tokens.terminal_background),
                ("terminal_foreground", tokens.terminal_foreground),
                ("terminal_cursor", tokens.terminal_cursor),
                ("terminal_selection", tokens.terminal_selection),
                ("message_surface", tokens.message_surface),
                ("message_foreground", tokens.message_foreground),
                ("shell_fill", tokens.shell_fill),
                ("shell_panel", tokens.shell_panel),
                ("shell_card", tokens.shell_card),
                ("shell_inner_fill", tokens.shell_inner_fill),
                ("shell_inner_border", tokens.shell_inner_border),
                ("shell_raised", tokens.shell_raised),
                ("shell_overlay", tokens.shell_overlay),
                ("shell_highlight", tokens.shell_highlight),
                ("shell_tile", tokens.shell_tile),
                ("shell_tile_border", tokens.shell_tile_border),
                ("shell_field", tokens.shell_field),
                ("shell_control", tokens.shell_control),
                ("shell_control_raised", tokens.shell_control_raised),
                (
                    "shell_control_raised_border",
                    tokens.shell_control_raised_border,
                ),
                ("shell_divider", tokens.shell_divider),
                ("shell_divider_header", tokens.shell_divider_header),
                ("shell_divider_raised", tokens.shell_divider_raised),
                ("shell_settings_card", tokens.shell_settings_card),
                (
                    "shell_settings_card_border",
                    tokens.shell_settings_card_border,
                ),
                ("shell_header_control", tokens.shell_header_control),
                (
                    "shell_header_control_hover",
                    tokens.shell_header_control_hover,
                ),
                ("glass_divider", tokens.glass_divider),
                ("muted_foreground_raised", tokens.muted_foreground_raised),
                ("switch_on", tokens.switch_on),
                ("sidebar_row_hover", tokens.sidebar_row_hover),
                ("sidebar_row_selected", tokens.sidebar_row_selected),
                ("sidebar_row_active", tokens.sidebar_row_active),
                ("diff_added", tokens.diff_added),
                ("diff_added_background", tokens.diff_added_background),
                ("diff_removed", tokens.diff_removed),
                ("diff_removed_background", tokens.diff_removed_background),
            ];
            for (name, color) in all_colors {
                assert_unit_rgba(color, &format!("{}.{name}", theme.id));
            }
        }
    }

    #[test]
    fn golden_dark_ocean_tokens() {
        // Expected hex+alpha values computed independently in Python using the CSS Color 4
        // OKLCH->OKLab->linear sRGB->gamma sRGB matrices and CSS Color 5 color-mix() formulas
        // applied to `crates/conn-theme/themes/dark-ocean.json` and `index.css` (`html.electron-macos.dark`).
        let Some(theme) = theme_by_id("dark-ocean") else {
            panic!("dark-ocean theme must exist");
        };
        let t = Tokens::derive(&theme);
        assert_eq!(t.appearance, Appearance::Dark, "dark-ocean appearance");

        assert_rgba_near(t.background, "#0d0f12", 1.0, "dark-ocean.background");
        assert_rgba_near(t.foreground, "#fbfcfd", 1.0, "dark-ocean.foreground");
        assert_rgba_near(t.sidebar, "#161a1e", 1.0, "dark-ocean.sidebar");
        assert_rgba_near(t.shell_fill, "#25292d", 0.60, "dark-ocean.shell_fill");
        assert_rgba_near(t.shell_card, "#161a1e", 1.0, "dark-ocean.shell_card");
        assert_rgba_near(
            t.shell_inner_fill,
            "#161a1e",
            0.76,
            "dark-ocean.shell_inner_fill",
        );
        assert_rgba_near(t.shell_divider, "#2b2e32", 1.0, "dark-ocean.shell_divider");
        assert_rgba_near(
            t.shell_divider_header,
            "#393c40",
            1.0,
            "dark-ocean.shell_divider_header",
        );
        assert_rgba_near(t.shell_control, "#272b2e", 1.0, "dark-ocean.shell_control");
        assert_rgba_near(t.shell_field, "#25292d", 1.0, "dark-ocean.shell_field");
        assert_rgba_near(t.switch_on, "#c2d0e0", 1.0, "dark-ocean.switch_on");
        assert_rgba_near(
            t.shell_inner_border,
            "#ffffff",
            0.08,
            "dark-ocean.shell_inner_border",
        );
        assert_rgba_near(
            t.sidebar_row_hover,
            "#ffffff",
            0.04,
            "dark-ocean.sidebar_row_hover",
        );
        assert_rgba_near(
            t.sidebar_row_selected,
            "#ffffff",
            0.06,
            "dark-ocean.sidebar_row_selected",
        );
        assert_rgba_near(
            t.sidebar_row_active,
            "#ffffff",
            0.08,
            "dark-ocean.sidebar_row_active",
        );
    }

    #[test]
    fn golden_t3_code_dark_tokens() {
        let Some(theme) = theme_by_id("t3-code-dark") else {
            panic!("t3-code-dark theme must exist");
        };
        let t = Tokens::derive(&theme);
        assert_eq!(t.appearance, Appearance::Dark, "t3-code-dark appearance");
        assert_rgba_near(t.sidebar, "#111111", 1.0, "t3-code-dark.sidebar");
        assert_rgba_near(t.shell_card, "#111111", 1.0, "t3-code-dark.shell_card");
        assert_rgba_near(t.shell_fill, "#202020", 0.60, "t3-code-dark.shell_fill");
        assert_rgba_near(
            t.shell_inner_fill,
            "#111111",
            0.76,
            "t3-code-dark.shell_inner_fill",
        );
    }

    #[test]
    fn golden_t3_code_light_tokens() {
        // Expected hex+alpha values computed independently in Python using the CSS Color 4/5
        // formulas applied to `T3_CODE_LIGHT_THEME_COLORS` and `index.css` (`html.electron-macos`).
        let Some(theme) = theme_by_id("t3-code-light") else {
            panic!("t3-code-light theme must exist");
        };
        let t = Tokens::derive(&theme);
        assert_eq!(t.appearance, Appearance::Light, "t3-code-light appearance");

        assert_rgba_near(t.background, "#fcfcfc", 1.0, "t3-code-light.background");
        assert_rgba_near(t.foreground, "#27272a", 1.0, "t3-code-light.foreground");
        assert_rgba_near(t.sidebar, "#fafafa", 1.0, "t3-code-light.sidebar");
        assert_rgba_near(t.shell_fill, "#fafafa", 0.60, "t3-code-light.shell_fill");
        assert_rgba_near(t.shell_card, "#fbfbfb", 1.0, "t3-code-light.shell_card");
        assert_rgba_near(
            t.shell_inner_fill,
            "#fbfbfb",
            0.76,
            "t3-code-light.shell_inner_fill",
        );
        assert_rgba_near(
            t.shell_divider,
            "#e2e2e3",
            1.0,
            "t3-code-light.shell_divider",
        );
        assert_rgba_near(
            t.shell_divider_header,
            "#d4d4d5",
            1.0,
            "t3-code-light.shell_divider_header",
        );
        assert_rgba_near(
            t.shell_control,
            "#fafafa",
            1.0,
            "t3-code-light.shell_control",
        );
        assert_rgba_near(t.shell_field, "#fafafa", 0.40, "t3-code-light.shell_field");
        assert_rgba_near(t.switch_on, "#2145a1", 1.0, "t3-code-light.switch_on");
        assert_rgba_near(
            t.shell_inner_border,
            "#000000",
            0.08,
            "t3-code-light.shell_inner_border",
        );
        assert_rgba_near(
            t.sidebar_row_hover,
            "#000000",
            0.03,
            "t3-code-light.sidebar_row_hover",
        );
        assert_rgba_near(
            t.sidebar_row_selected,
            "#000000",
            0.05,
            "t3-code-light.sidebar_row_selected",
        );
        assert_rgba_near(
            t.sidebar_row_active,
            "#000000",
            0.07,
            "t3-code-light.sidebar_row_active",
        );
    }

    #[test]
    fn parse_theme_json_applies_fallbacks_and_rejects_bad_color() {
        let partial =
            r##"{"version":1,"name":"Minimal","appearance":"dark","colors":{"canvas":"#102030"}}"##;
        let Ok(theme) = parse_theme_json("minimal", partial) else {
            panic!("partial theme JSON should parse");
        };
        assert_eq!(theme.id, "minimal", "theme id");
        assert_eq!(theme.name, "Minimal", "theme name");
        let tokens = Tokens::derive(&theme);
        assert_rgba_near(tokens.background, "#102030", 1.0, "minimal.background");
        assert!(
            theme.roles.contains_key("sidebar"),
            "missing roles must fall back to appearance defaults"
        );

        let bad =
            r#"{"version":1,"name":"Bad","appearance":"dark","colors":{"canvas":"not-a-color"}}"#;
        let err = parse_theme_json("bad", bad);
        assert!(err.is_err(), "invalid color must return ThemeError::Color");
    }

    #[test]
    fn theme_from_role_colors_skips_invalid_values_leniently() {
        let mut colors = BTreeMap::new();
        colors.insert("canvas".to_owned(), "#123456".to_owned());
        colors.insert("accent".to_owned(), "not-a-valid-color".to_owned());
        let theme =
            theme_from_role_colors("orbit-custom", "Orbit Custom", Appearance::Dark, &colors);
        assert_eq!(theme.id, "orbit-custom");
        assert_eq!(theme.name, "Orbit Custom");
        let tokens = Tokens::derive(&theme);
        assert_rgba_near(tokens.background, "#123456", 1.0, "orbit-custom.background");
        assert!(theme.roles.contains_key("accent"));
    }

    #[test]
    fn popover_is_opaque_even_when_the_theme_role_is_translucent() {
        for theme in builtin_themes() {
            assert_eq!(Tokens::derive(&theme).popover.a, 1.0, "{}", theme.id);
        }
        let Some(mut theme) = theme_by_id("dark-ocean") else {
            panic!("dark-ocean must be built in");
        };
        theme
            .roles
            .insert("surfaceOverlay".to_owned(), Rgba::new(0.2, 0.3, 0.4, 0.5));
        let popover = Tokens::derive(&theme).popover;
        assert_eq!(popover.a, 1.0);
        assert_eq!((popover.r, popover.g, popover.b), (0.2, 0.3, 0.4));
    }
}
