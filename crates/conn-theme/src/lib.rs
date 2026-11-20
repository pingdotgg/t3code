#![forbid(unsafe_code)]

//! Conn theme palettes and `nckrtl-shell-design` token derivation.
//!
//! Mirrors `../conn/packages/shared/src/themePalettes.ts` and the shell token formulas in
//! `../conn/apps/web/src/index.css` (summarized in `docs/design-spec.md`).

/// Light or dark theme appearance.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Appearance {
    Light,
    Dark,
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
