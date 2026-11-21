#![forbid(unsafe_code)]

//! Conn theme palettes and `nckrtl-shell-design` token derivation.
//!
//! Mirrors `../conn/packages/shared/src/themePalettes.ts` and the shell token formulas in
//! `../conn/apps/web/src/index.css` (summarized in `docs/design-spec.md`).
//!
//! This crate is GPUI-free. `conn-app` converts [`Rgba`] into GPUI colors.
//!
//! API contract (other crates build against these names; keep them stable):
//! - [`Rgba`]: straight-alpha sRGB, every channel `0.0..=1.0`.
//! - [`ThemeDefinition`]: one theme's id, name, appearance, and color roles.
//! - [`builtin_themes`], [`theme_by_id`], [`parse_theme_json`].
//! - [`Tokens::derive`]: every semantic and shell token the views paint with.

use std::collections::BTreeMap;

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

    pub const fn new(r: f32, g: f32, b: f32, a: f32) -> Self {
        Self { r, g, b, a }
    }

    /// `0xRRGGBB`, opaque.
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
/// `../conn/packages/shared/src/themePalettes.ts` (`canvas`, `text`, `sidebar`, ...).
#[derive(Clone, Debug, PartialEq)]
pub struct ThemeDefinition {
    pub id: String,
    pub name: String,
    pub appearance: Appearance,
    pub roles: BTreeMap<String, Rgba>,
}

/// Every built-in theme, Dark Ocean first, then T3 Code Light.
pub fn builtin_themes() -> Vec<ThemeDefinition> {
    Vec::new()
}

/// A built-in theme by id (`dark-ocean`, `t3-code-light`, `t3-code-dark`, ...).
pub fn theme_by_id(id: &str) -> Option<ThemeDefinition> {
    builtin_themes().into_iter().find(|t| t.id == id)
}

/// Parses a Conn custom theme file (`{"version":1,"name":..,"appearance":..,"colors":{..}}`),
/// such as `~/.t3/dev/themes/dark-ocean.json`. Colors may be `oklch(..)`, `#hex`, or `rgb(..)`.
pub fn parse_theme_json(id: &str, json: &str) -> Result<ThemeDefinition, ThemeError> {
    let _ = (id, json);
    Err(ThemeError::Color {
        role: String::new(),
        value: "not implemented".into(),
    })
}

/// Every color a view paints with, derived from one theme.
///
/// Field names follow the CSS custom properties (`--shell-divider-header` →
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
    /// Derives every token from `theme` exactly as `index.css` does.
    pub fn derive(theme: &ThemeDefinition) -> Self {
        let _ = theme;
        Self::placeholder_dark()
    }

    /// Neutral dark placeholder used until real derivation lands.
    pub fn placeholder_dark() -> Self {
        let bg = Rgba::hex(0x15181c);
        let fg = Rgba::hex(0xf7f8fa);
        let sidebar = Rgba::hex(0x1c2026);
        let mid = Rgba::hex(0x2a2f36);
        let muted = Rgba::hex(0x9aa0a8);
        let line = Rgba::hex(0x30353c);
        Self {
            appearance: Appearance::Dark,
            background: bg,
            foreground: fg,
            card: bg,
            card_foreground: fg,
            popover: mid,
            popover_foreground: fg,
            primary: Rgba::hex(0xa9b8c9),
            primary_foreground: bg,
            secondary: mid,
            secondary_foreground: fg,
            muted: mid,
            muted_foreground: muted,
            accent: mid,
            accent_foreground: fg,
            border: line,
            input: line,
            ring: Rgba::hex(0xa9b8c9),
            placeholder: muted,
            destructive: Rgba::hex(0xf0565b),
            destructive_foreground: Rgba::hex(0xff7b7b),
            warning: Rgba::hex(0xf0a63a),
            warning_foreground: Rgba::hex(0xf5c542),
            info: Rgba::hex(0x5aa0f0),
            info_foreground: Rgba::hex(0x8cbcf5),
            success: Rgba::hex(0x3ecf7a),
            success_foreground: Rgba::hex(0x6fe0a0),
            sidebar,
            sidebar_foreground: fg,
            sidebar_muted_foreground: muted,
            sidebar_border: line,
            toolbar_control: mid,
            toolbar_control_hover: line,
            code_background: Rgba::hex(0x1d2024),
            code_foreground: fg,
            terminal_background: bg,
            terminal_foreground: fg,
            terminal_cursor: Rgba::hex(0xa9b8c9),
            terminal_selection: line,
            message_surface: Rgba::hex(0x353b44),
            message_foreground: fg,
            shell_fill: Rgba::hex(0x2a2e34).with_alpha(0.6),
            shell_panel: sidebar,
            shell_card: sidebar,
            shell_inner_fill: sidebar.with_alpha(0.76),
            shell_inner_border: Rgba::new(1.0, 1.0, 1.0, 0.08),
            shell_raised: mid,
            shell_overlay: mid.with_alpha(0.94),
            shell_highlight: fg.with_alpha(0.08),
            shell_tile: line,
            shell_tile_border: mid,
            shell_field: mid,
            shell_control: mid,
            shell_control_raised: line,
            shell_control_raised_border: line,
            shell_divider: line,
            shell_divider_header: line,
            shell_divider_raised: line,
            shell_settings_card: mid,
            shell_settings_card_border: line,
            shell_header_control: mid,
            shell_header_control_hover: line,
            glass_divider: fg.with_alpha(0.08),
            muted_foreground_raised: muted,
            switch_on: Rgba::hex(0xa9b8c9),
            sidebar_row_hover: Rgba::new(1.0, 1.0, 1.0, 0.04),
            sidebar_row_selected: Rgba::new(1.0, 1.0, 1.0, 0.06),
            sidebar_row_active: Rgba::new(1.0, 1.0, 1.0, 0.08),
            diff_added: Rgba::hex(0x3ecf7a),
            diff_added_background: Rgba::hex(0x3ecf7a).with_alpha(0.12),
            diff_removed: Rgba::hex(0xf0565b),
            diff_removed_background: Rgba::hex(0xf0565b).with_alpha(0.12),
        }
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
