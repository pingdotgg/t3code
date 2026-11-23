//! UniFFI theme palette and shell token exports backed by [`conn_theme`].

use conn_theme::{Appearance, Rgba, ShellGeometry, ThemeDefinition, Tokens};

use crate::types::FfiError;

/// Light or dark theme appearance (mirrors [`conn_theme::Appearance`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiAppearance {
    Light,
    Dark,
}

impl From<Appearance> for FfiAppearance {
    fn from(value: Appearance) -> Self {
        match value {
            Appearance::Light => Self::Light,
            Appearance::Dark => Self::Dark,
        }
    }
}

/// Straight-alpha sRGB color with channels in `0.0..=1.0` (mirrors [`conn_theme::Rgba`]).
#[derive(Clone, Copy, Debug, PartialEq, uniffi::Record)]
pub struct FfiColor {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl From<Rgba> for FfiColor {
    fn from(value: Rgba) -> Self {
        Self {
            r: value.r,
            g: value.g,
            b: value.b,
            a: value.a,
        }
    }
}

/// Metadata summary for one built-in Conn theme.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiThemeSummary {
    pub id: String,
    pub name: String,
    pub appearance: FfiAppearance,
}

/// Core shell geometric constants (mirrors [`conn_theme::ShellGeometry`]).
#[derive(Clone, Copy, Debug, PartialEq, uniffi::Record)]
pub struct FfiShellGeometry {
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

impl From<ShellGeometry> for FfiShellGeometry {
    fn from(geometry: ShellGeometry) -> Self {
        let ShellGeometry {
            window_radius_px,
            shell_inset_px,
            shell_corner_px,
            header_height_px,
            workspace_controls_right_px,
            ui_font_size_px,
            ui_line_height_px,
            toolbar_height_px,
            bubble_radius_px,
        } = geometry;
        Self {
            window_radius_px,
            shell_inset_px,
            shell_corner_px,
            header_height_px,
            workspace_controls_right_px,
            ui_font_size_px,
            ui_line_height_px,
            toolbar_height_px,
            bubble_radius_px,
        }
    }
}

/// Every semantic and shell color token derived from one Conn theme, plus shell geometry.
///
/// Field names match [`conn_theme::Tokens`] 1:1 in `snake_case`.
#[derive(Clone, Copy, Debug, PartialEq, uniffi::Record)]
pub struct FfiThemeTokens {
    pub appearance: FfiAppearance,
    pub background: FfiColor,
    pub foreground: FfiColor,
    pub card: FfiColor,
    pub card_foreground: FfiColor,
    pub popover: FfiColor,
    pub popover_foreground: FfiColor,
    pub primary: FfiColor,
    pub primary_foreground: FfiColor,
    pub secondary: FfiColor,
    pub secondary_foreground: FfiColor,
    pub muted: FfiColor,
    pub muted_foreground: FfiColor,
    pub accent: FfiColor,
    pub accent_foreground: FfiColor,
    pub border: FfiColor,
    pub input: FfiColor,
    pub ring: FfiColor,
    pub placeholder: FfiColor,
    pub destructive: FfiColor,
    pub destructive_foreground: FfiColor,
    pub warning: FfiColor,
    pub warning_foreground: FfiColor,
    pub info: FfiColor,
    pub info_foreground: FfiColor,
    pub success: FfiColor,
    pub success_foreground: FfiColor,
    pub sidebar: FfiColor,
    pub sidebar_foreground: FfiColor,
    pub sidebar_muted_foreground: FfiColor,
    pub sidebar_border: FfiColor,
    pub toolbar_control: FfiColor,
    pub toolbar_control_hover: FfiColor,
    pub code_background: FfiColor,
    pub code_foreground: FfiColor,
    pub terminal_background: FfiColor,
    pub terminal_foreground: FfiColor,
    pub terminal_cursor: FfiColor,
    pub terminal_selection: FfiColor,
    pub message_surface: FfiColor,
    pub message_foreground: FfiColor,
    pub shell_fill: FfiColor,
    pub shell_panel: FfiColor,
    pub shell_card: FfiColor,
    pub shell_inner_fill: FfiColor,
    pub shell_inner_border: FfiColor,
    pub shell_raised: FfiColor,
    pub shell_overlay: FfiColor,
    pub shell_highlight: FfiColor,
    pub shell_tile: FfiColor,
    pub shell_tile_border: FfiColor,
    pub shell_field: FfiColor,
    pub shell_control: FfiColor,
    pub shell_control_raised: FfiColor,
    pub shell_control_raised_border: FfiColor,
    pub shell_divider: FfiColor,
    pub shell_divider_header: FfiColor,
    pub shell_divider_raised: FfiColor,
    pub shell_settings_card: FfiColor,
    pub shell_settings_card_border: FfiColor,
    pub shell_header_control: FfiColor,
    pub shell_header_control_hover: FfiColor,
    pub glass_divider: FfiColor,
    pub muted_foreground_raised: FfiColor,
    pub switch_on: FfiColor,
    pub sidebar_row_hover: FfiColor,
    pub sidebar_row_selected: FfiColor,
    pub sidebar_row_active: FfiColor,
    pub diff_added: FfiColor,
    pub diff_added_background: FfiColor,
    pub diff_removed: FfiColor,
    pub diff_removed_background: FfiColor,
    pub geometry: FfiShellGeometry,
}

fn derive_ffi_tokens(theme: &ThemeDefinition) -> FfiThemeTokens {
    let Tokens {
        appearance,
        background,
        foreground,
        card,
        card_foreground,
        popover,
        popover_foreground,
        primary,
        primary_foreground,
        secondary,
        secondary_foreground,
        muted,
        muted_foreground,
        accent,
        accent_foreground,
        border,
        input,
        ring,
        placeholder,
        destructive,
        destructive_foreground,
        warning,
        warning_foreground,
        info,
        info_foreground,
        success,
        success_foreground,
        sidebar,
        sidebar_foreground,
        sidebar_muted_foreground,
        sidebar_border,
        toolbar_control,
        toolbar_control_hover,
        code_background,
        code_foreground,
        terminal_background,
        terminal_foreground,
        terminal_cursor,
        terminal_selection,
        message_surface,
        message_foreground,
        shell_fill,
        shell_panel,
        shell_card,
        shell_inner_fill,
        shell_inner_border,
        shell_raised,
        shell_overlay,
        shell_highlight,
        shell_tile,
        shell_tile_border,
        shell_field,
        shell_control,
        shell_control_raised,
        shell_control_raised_border,
        shell_divider,
        shell_divider_header,
        shell_divider_raised,
        shell_settings_card,
        shell_settings_card_border,
        shell_header_control,
        shell_header_control_hover,
        glass_divider,
        muted_foreground_raised,
        switch_on,
        sidebar_row_hover,
        sidebar_row_selected,
        sidebar_row_active,
        diff_added,
        diff_added_background,
        diff_removed,
        diff_removed_background,
    } = Tokens::derive(theme);

    FfiThemeTokens {
        appearance: appearance.into(),
        background: background.into(),
        foreground: foreground.into(),
        card: card.into(),
        card_foreground: card_foreground.into(),
        popover: popover.into(),
        popover_foreground: popover_foreground.into(),
        primary: primary.into(),
        primary_foreground: primary_foreground.into(),
        secondary: secondary.into(),
        secondary_foreground: secondary_foreground.into(),
        muted: muted.into(),
        muted_foreground: muted_foreground.into(),
        accent: accent.into(),
        accent_foreground: accent_foreground.into(),
        border: border.into(),
        input: input.into(),
        ring: ring.into(),
        placeholder: placeholder.into(),
        destructive: destructive.into(),
        destructive_foreground: destructive_foreground.into(),
        warning: warning.into(),
        warning_foreground: warning_foreground.into(),
        info: info.into(),
        info_foreground: info_foreground.into(),
        success: success.into(),
        success_foreground: success_foreground.into(),
        sidebar: sidebar.into(),
        sidebar_foreground: sidebar_foreground.into(),
        sidebar_muted_foreground: sidebar_muted_foreground.into(),
        sidebar_border: sidebar_border.into(),
        toolbar_control: toolbar_control.into(),
        toolbar_control_hover: toolbar_control_hover.into(),
        code_background: code_background.into(),
        code_foreground: code_foreground.into(),
        terminal_background: terminal_background.into(),
        terminal_foreground: terminal_foreground.into(),
        terminal_cursor: terminal_cursor.into(),
        terminal_selection: terminal_selection.into(),
        message_surface: message_surface.into(),
        message_foreground: message_foreground.into(),
        shell_fill: shell_fill.into(),
        shell_panel: shell_panel.into(),
        shell_card: shell_card.into(),
        shell_inner_fill: shell_inner_fill.into(),
        shell_inner_border: shell_inner_border.into(),
        shell_raised: shell_raised.into(),
        shell_overlay: shell_overlay.into(),
        shell_highlight: shell_highlight.into(),
        shell_tile: shell_tile.into(),
        shell_tile_border: shell_tile_border.into(),
        shell_field: shell_field.into(),
        shell_control: shell_control.into(),
        shell_control_raised: shell_control_raised.into(),
        shell_control_raised_border: shell_control_raised_border.into(),
        shell_divider: shell_divider.into(),
        shell_divider_header: shell_divider_header.into(),
        shell_divider_raised: shell_divider_raised.into(),
        shell_settings_card: shell_settings_card.into(),
        shell_settings_card_border: shell_settings_card_border.into(),
        shell_header_control: shell_header_control.into(),
        shell_header_control_hover: shell_header_control_hover.into(),
        glass_divider: glass_divider.into(),
        muted_foreground_raised: muted_foreground_raised.into(),
        switch_on: switch_on.into(),
        sidebar_row_hover: sidebar_row_hover.into(),
        sidebar_row_selected: sidebar_row_selected.into(),
        sidebar_row_active: sidebar_row_active.into(),
        diff_added: diff_added.into(),
        diff_added_background: diff_added_background.into(),
        diff_removed: diff_removed.into(),
        diff_removed_background: diff_removed_background.into(),
        geometry: ShellGeometry::default().into(),
    }
}

/// Returns every built-in Conn theme in the desktop client's canonical order.
#[must_use]
#[uniffi::export]
pub fn builtin_themes() -> Vec<FfiThemeSummary> {
    conn_theme::builtin_themes()
        .into_iter()
        .map(|theme| FfiThemeSummary {
            id: theme.id,
            name: theme.name,
            appearance: theme.appearance.into(),
        })
        .collect()
}

/// Derives every color and shell geometry token for a built-in Conn theme id.
#[must_use]
#[uniffi::export]
pub fn theme_tokens(theme_id: String) -> Option<FfiThemeTokens> {
    let theme = conn_theme::theme_by_id(&theme_id)?;
    Some(derive_ffi_tokens(&theme))
}

/// Parses a Conn custom theme JSON payload and derives every color and shell geometry token.
///
/// # Errors
///
/// Returns [`FfiError::InvalidTheme`] if `json` is malformed or contains an invalid CSS color.
#[uniffi::export]
pub fn custom_theme_tokens(id: String, json: String) -> Result<FfiThemeTokens, FfiError> {
    let theme = conn_theme::parse_theme_json(&id, &json).map_err(|err| FfiError::InvalidTheme {
        message: err.to_string(),
    })?;
    Ok(derive_ffi_tokens(&theme))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Counts fields of `conn_theme::Tokens` via exhaustive destructuring so adding a new desktop
    /// token causes a compile error here unless mirrored onto `FfiThemeTokens`.
    fn count_tokens_fields(t: &Tokens) -> usize {
        let Tokens {
            appearance: _,
            background: _,
            foreground: _,
            card: _,
            card_foreground: _,
            popover: _,
            popover_foreground: _,
            primary: _,
            primary_foreground: _,
            secondary: _,
            secondary_foreground: _,
            muted: _,
            muted_foreground: _,
            accent: _,
            accent_foreground: _,
            border: _,
            input: _,
            ring: _,
            placeholder: _,
            destructive: _,
            destructive_foreground: _,
            warning: _,
            warning_foreground: _,
            info: _,
            info_foreground: _,
            success: _,
            success_foreground: _,
            sidebar: _,
            sidebar_foreground: _,
            sidebar_muted_foreground: _,
            sidebar_border: _,
            toolbar_control: _,
            toolbar_control_hover: _,
            code_background: _,
            code_foreground: _,
            terminal_background: _,
            terminal_foreground: _,
            terminal_cursor: _,
            terminal_selection: _,
            message_surface: _,
            message_foreground: _,
            shell_fill: _,
            shell_panel: _,
            shell_card: _,
            shell_inner_fill: _,
            shell_inner_border: _,
            shell_raised: _,
            shell_overlay: _,
            shell_highlight: _,
            shell_tile: _,
            shell_tile_border: _,
            shell_field: _,
            shell_control: _,
            shell_control_raised: _,
            shell_control_raised_border: _,
            shell_divider: _,
            shell_divider_header: _,
            shell_divider_raised: _,
            shell_settings_card: _,
            shell_settings_card_border: _,
            shell_header_control: _,
            shell_header_control_hover: _,
            glass_divider: _,
            muted_foreground_raised: _,
            switch_on: _,
            sidebar_row_hover: _,
            sidebar_row_selected: _,
            sidebar_row_active: _,
            diff_added: _,
            diff_added_background: _,
            diff_removed: _,
            diff_removed_background: _,
        } = t;
        72
    }

    fn count_ffi_token_fields(t: &FfiThemeTokens) -> usize {
        let FfiThemeTokens {
            appearance: _,
            background,
            foreground,
            card,
            card_foreground,
            popover,
            popover_foreground,
            primary,
            primary_foreground,
            secondary,
            secondary_foreground,
            muted,
            muted_foreground,
            accent,
            accent_foreground,
            border,
            input,
            ring,
            placeholder,
            destructive,
            destructive_foreground,
            warning,
            warning_foreground,
            info,
            info_foreground,
            success,
            success_foreground,
            sidebar,
            sidebar_foreground,
            sidebar_muted_foreground,
            sidebar_border,
            toolbar_control,
            toolbar_control_hover,
            code_background,
            code_foreground,
            terminal_background,
            terminal_foreground,
            terminal_cursor,
            terminal_selection,
            message_surface,
            message_foreground,
            shell_fill,
            shell_panel,
            shell_card,
            shell_inner_fill,
            shell_inner_border,
            shell_raised,
            shell_overlay,
            shell_highlight,
            shell_tile,
            shell_tile_border,
            shell_field,
            shell_control,
            shell_control_raised,
            shell_control_raised_border,
            shell_divider,
            shell_divider_header,
            shell_divider_raised,
            shell_settings_card,
            shell_settings_card_border,
            shell_header_control,
            shell_header_control_hover,
            glass_divider,
            muted_foreground_raised,
            switch_on,
            sidebar_row_hover,
            sidebar_row_selected,
            sidebar_row_active,
            diff_added,
            diff_added_background,
            diff_removed,
            diff_removed_background,
            geometry:
                FfiShellGeometry {
                    window_radius_px: _,
                    shell_inset_px: _,
                    shell_corner_px: _,
                    header_height_px: _,
                    workspace_controls_right_px: _,
                    ui_font_size_px: _,
                    ui_line_height_px: _,
                    toolbar_height_px: _,
                    bubble_radius_px: _,
                },
        } = t;
        let colors = [
            background,
            foreground,
            card,
            card_foreground,
            popover,
            popover_foreground,
            primary,
            primary_foreground,
            secondary,
            secondary_foreground,
            muted,
            muted_foreground,
            accent,
            accent_foreground,
            border,
            input,
            ring,
            placeholder,
            destructive,
            destructive_foreground,
            warning,
            warning_foreground,
            info,
            info_foreground,
            success,
            success_foreground,
            sidebar,
            sidebar_foreground,
            sidebar_muted_foreground,
            sidebar_border,
            toolbar_control,
            toolbar_control_hover,
            code_background,
            code_foreground,
            terminal_background,
            terminal_foreground,
            terminal_cursor,
            terminal_selection,
            message_surface,
            message_foreground,
            shell_fill,
            shell_panel,
            shell_card,
            shell_inner_fill,
            shell_inner_border,
            shell_raised,
            shell_overlay,
            shell_highlight,
            shell_tile,
            shell_tile_border,
            shell_field,
            shell_control,
            shell_control_raised,
            shell_control_raised_border,
            shell_divider,
            shell_divider_header,
            shell_divider_raised,
            shell_settings_card,
            shell_settings_card_border,
            shell_header_control,
            shell_header_control_hover,
            glass_divider,
            muted_foreground_raised,
            switch_on,
            sidebar_row_hover,
            sidebar_row_selected,
            sidebar_row_active,
            diff_added,
            diff_added_background,
            diff_removed,
            diff_removed_background,
        ];
        // 1 appearance + 71 FfiColor fields = 72 Tokens fields.
        1 + colors.len()
    }

    #[test]
    fn ffi_theme_tokens_field_count_matches_conn_theme_tokens() {
        let theme = conn_theme::theme_by_id("dark-ocean").expect("dark-ocean theme must exist");
        let desktop = Tokens::derive(&theme);
        let ffi = theme_tokens("dark-ocean".to_owned()).expect("dark-ocean tokens must resolve");

        assert_eq!(
            count_ffi_token_fields(&ffi),
            count_tokens_fields(&desktop),
            "FfiThemeTokens must carry every field of conn_theme::Tokens"
        );
        assert_eq!(
            std::mem::size_of::<FfiThemeTokens>(),
            std::mem::size_of::<Tokens>() + std::mem::size_of::<FfiShellGeometry>(),
            "FfiThemeTokens layout size must match Tokens + FfiShellGeometry (no dropped fields)"
        );
        assert_eq!(ffi.appearance, FfiAppearance::Dark);
        assert_eq!(ffi.background, desktop.background.into());
        assert_eq!(ffi.shell_fill, desktop.shell_fill.into());
        assert_eq!(
            ffi.diff_removed_background,
            desktop.diff_removed_background.into()
        );
        assert_eq!(ffi.geometry, ShellGeometry::default().into());
    }

    #[test]
    fn builtin_themes_matches_desktop_order_and_resolves_every_theme() {
        let desktop = conn_theme::builtin_themes();
        let ffi = builtin_themes();
        assert_eq!(
            ffi.len(),
            desktop.len(),
            "builtin_themes count must match conn_theme::builtin_themes"
        );
        for (ffi_summary, desktop_def) in ffi.iter().zip(desktop.iter()) {
            assert_eq!(ffi_summary.id, desktop_def.id);
            assert_eq!(ffi_summary.name, desktop_def.name);
            assert_eq!(ffi_summary.appearance, desktop_def.appearance.into());
            let resolved = theme_tokens(ffi_summary.id.clone());
            assert!(
                resolved.is_some(),
                "every builtin theme id ({}) must resolve via theme_tokens",
                ffi_summary.id
            );
        }
        assert!(
            theme_tokens("does-not-exist".to_owned()).is_none(),
            "unknown theme id must return None"
        );
    }

    #[test]
    fn custom_theme_tokens_parses_valid_json_and_rejects_bad_input() {
        let valid = r##"{"version":1,"name":"Midnight","appearance":"dark","colors":{"canvas":"#102030"}}"##;
        let tokens = custom_theme_tokens("midnight".to_owned(), valid.to_owned())
            .expect("valid custom theme JSON must succeed");
        assert_eq!(tokens.appearance, FfiAppearance::Dark);
        assert!(
            (tokens.background.r - (16.0 / 255.0)).abs() < 1e-4
                && (tokens.background.g - (32.0 / 255.0)).abs() < 1e-4
                && (tokens.background.b - (48.0 / 255.0)).abs() < 1e-4,
            "custom canvas color must propagate to background token"
        );

        let invalid = r#"{"version":1,"name":"Broken","appearance":"dark","colors":{"canvas":"not-a-color"}}"#;
        let err = custom_theme_tokens("broken".to_owned(), invalid.to_owned())
            .expect_err("invalid CSS color must fail");
        assert!(
            matches!(err, FfiError::InvalidTheme { .. }),
            "expected InvalidTheme error, got {err:?}"
        );
    }
}
