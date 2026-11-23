//! Derives Conn's semantic and macOS Electron shell [`Tokens`] from a [`ThemeDefinition`].

use crate::color::{color_mix_oklab, color_mix_srgb, oklch_to_rgba};
use crate::palettes::default_roles_for_appearance;
use crate::{Appearance, Rgba, ThemeDefinition, Tokens};

// Tailwind v4 status tokens that Conn keeps independent of theme roles (`index.css` lines 1201-1262).
fn tailwind_blue_500() -> Rgba {
    oklch_to_rgba(0.623, 0.214, 259.815, 1.0)
}
fn tailwind_blue_700() -> Rgba {
    oklch_to_rgba(0.488, 0.243, 264.376, 1.0)
}
fn tailwind_blue_400() -> Rgba {
    oklch_to_rgba(0.707, 0.165, 254.624, 1.0)
}
fn tailwind_emerald_500() -> Rgba {
    oklch_to_rgba(0.696, 0.17, 162.48, 1.0)
}
fn tailwind_emerald_700() -> Rgba {
    oklch_to_rgba(0.508, 0.118, 165.612, 1.0)
}
fn tailwind_emerald_400() -> Rgba {
    oklch_to_rgba(0.765, 0.177, 163.223, 1.0)
}

/// Derives every semantic and macOS shell token from `theme`, mirroring
/// `html[data-theme-id]` + `:root`/`:root.dark` + `html.electron-macos` in `index.css`.
pub(crate) fn derive_tokens(theme: &ThemeDefinition) -> Tokens {
    let fallback = default_roles_for_appearance(theme.appearance);
    let role = |name: &str| -> Rgba {
        theme
            .roles
            .get(name)
            .copied()
            .or_else(|| {
                if name == "terminalSelection" {
                    theme.roles.get("terminalSelectionBackground").copied()
                } else {
                    None
                }
            })
            .or_else(|| fallback.get(name).copied())
            .unwrap_or(Rgba::TRANSPARENT)
    };

    // Role -> CSS custom property mapping (`index.css` lines 1370-1434).
    let background = role("canvas");
    let foreground = role("text");
    let card = role("surface");
    let card_foreground = foreground;
    let popover = role("surfaceOverlay");
    let popover_foreground = foreground;
    // Solid controls share the theme's messageAction role (`--primary: var(--app-theme-message-action)`).
    let primary = role("messageAction");
    let primary_foreground = role("messageActionForeground");
    let secondary = role("secondary");
    let secondary_foreground = role("secondaryForeground");
    let muted = role("muted");
    let muted_foreground = role("mutedForeground");
    let accent = role("accentSurface");
    let accent_foreground = role("accentSurfaceForeground");
    let border = role("border");
    let input = role("input");
    let ring = role("focus");
    let placeholder = role("placeholder");
    let destructive = role("error");
    let destructive_foreground = role("errorForeground");
    let warning = role("warning");
    let warning_foreground = role("warningForeground");
    let sidebar = role("sidebar");
    let sidebar_foreground = role("sidebarForeground");
    let sidebar_muted_foreground = role("sidebarMutedForeground");
    let sidebar_border = role("sidebarBorder");
    let sidebar_row_active_role = role("sidebarRowActive");
    let toolbar_control = role("toolbarControl");
    let toolbar_control_hover = role("toolbarControlHover");
    let code_background = role("codeBackground");
    let code_foreground = role("codeForeground");
    let terminal_background = role("terminalBackground");
    let terminal_foreground = role("terminalForeground");
    let terminal_cursor = role("terminalCursor");
    let terminal_selection = role("terminalSelection");
    let message_surface = role("messageSurface");
    let message_foreground = role("messageForeground");

    // Non-themed status colors (`index.css` lines 1201-1262).
    let info = tailwind_blue_500();
    let success = tailwind_emerald_500();
    let (info_foreground, success_foreground) = match theme.appearance {
        Appearance::Light => (tailwind_blue_700(), tailwind_emerald_700()),
        Appearance::Dark => (tailwind_blue_400(), tailwind_emerald_400()),
    };

    // Shell tokens (`index.css` lines 2624-2755, plus `html.electron-macos` lines 2850-2912).
    let glass_divider = color_mix_srgb(foreground, 0.08, Rgba::TRANSPARENT);
    let switch_on = color_mix_oklab(primary, 0.70, foreground);

    let (
        shell_panel,
        shell_card,
        shell_fill,
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
        muted_foreground_raised,
        sidebar_row_hover,
        sidebar_row_selected,
        sidebar_row_active,
    ) = match theme.appearance {
        Appearance::Light => {
            let shell_panel = color_mix_oklab(sidebar, 0.40, background);
            let shell_card = shell_panel;
            let shell_fill = color_mix_srgb(sidebar, 0.60, Rgba::TRANSPARENT);
            let shell_inner_fill = color_mix_srgb(shell_card, 0.76, Rgba::TRANSPARENT);
            let shell_inner_border = Rgba::new(0.0, 0.0, 0.0, 0.08);
            let shell_raised = background;
            let shell_overlay = color_mix_srgb(popover, 0.94, Rgba::TRANSPARENT);
            let shell_highlight = color_mix_srgb(foreground, 0.06, Rgba::TRANSPARENT);
            let shell_tile = card;
            let shell_tile_border = color_mix_srgb(sidebar, 0.94, foreground);
            let shell_field = color_mix_srgb(muted, 0.40, Rgba::TRANSPARENT);
            let shell_control = sidebar;
            let shell_divider = color_mix_oklab(sidebar, 0.90, foreground);
            let shell_divider_header = color_mix_oklab(sidebar, 0.84, foreground);
            let shell_divider_raised = color_mix_oklab(sidebar, 0.80, foreground);
            let shell_control_raised = card;
            let shell_control_raised_border = shell_divider_header;
            let shell_settings_card = sidebar_row_active_role;
            let shell_settings_card_border = shell_divider_header;
            let shell_header_control = toolbar_control;
            let shell_header_control_hover = toolbar_control_hover;
            let muted_foreground_raised = color_mix_oklab(muted_foreground, 0.80, foreground);
            let sidebar_row_hover = Rgba::new(0.0, 0.0, 0.0, 0.03);
            let sidebar_row_selected = Rgba::new(0.0, 0.0, 0.0, 0.05);
            let sidebar_row_active = Rgba::new(0.0, 0.0, 0.0, 0.07);

            (
                shell_panel,
                shell_card,
                shell_fill,
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
                muted_foreground_raised,
                sidebar_row_hover,
                sidebar_row_selected,
                sidebar_row_active,
            )
        }
        Appearance::Dark => {
            let shell_panel = sidebar;
            let shell_card = shell_panel;
            let shell_fill = color_mix_srgb(
                color_mix_oklab(sidebar, 0.92, foreground),
                0.60,
                Rgba::TRANSPARENT,
            );
            let shell_inner_fill = color_mix_srgb(shell_card, 0.76, Rgba::TRANSPARENT);
            let shell_inner_border = Rgba::new(1.0, 1.0, 1.0, 0.08);
            let shell_raised = color_mix_oklab(background, 0.86, foreground);
            let shell_overlay = color_mix_srgb(
                color_mix_oklab(popover, 0.96, foreground),
                0.94,
                Rgba::TRANSPARENT,
            );
            let shell_highlight = color_mix_srgb(foreground, 0.08, Rgba::TRANSPARENT);
            let shell_tile = color_mix_oklab(sidebar, 0.80, foreground);
            let shell_tile_border = color_mix_srgb(sidebar, 0.92, foreground);
            let shell_field = color_mix_oklab(sidebar, 0.92, foreground);
            let shell_control = color_mix_oklab(sidebar, 0.91, foreground);
            let shell_control_raised = color_mix_oklab(sidebar, 0.86, foreground);
            let shell_control_raised_border = color_mix_oklab(sidebar, 0.74, foreground);
            let shell_divider = color_mix_oklab(sidebar, 0.89, foreground);
            let shell_divider_header = color_mix_oklab(sidebar, 0.82, foreground);
            let shell_divider_raised = color_mix_oklab(sidebar, 0.78, foreground);
            let shell_settings_card = color_mix_oklab(sidebar_row_active_role, 0.78, sidebar);
            let shell_settings_card_border = color_mix_oklab(shell_settings_card, 0.90, foreground);
            let shell_header_control =
                color_mix_oklab(toolbar_control, 0.50, toolbar_control_hover);
            let shell_header_control_hover =
                color_mix_oklab(toolbar_control_hover, 0.94, foreground);
            let muted_foreground_raised = color_mix_oklab(muted_foreground, 0.88, foreground);
            let sidebar_row_hover = Rgba::new(1.0, 1.0, 1.0, 0.04);
            let sidebar_row_selected = Rgba::new(1.0, 1.0, 1.0, 0.06);
            let sidebar_row_active = Rgba::new(1.0, 1.0, 1.0, 0.08);

            (
                shell_panel,
                shell_card,
                shell_fill,
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
                muted_foreground_raised,
                sidebar_row_hover,
                sidebar_row_selected,
                sidebar_row_active,
            )
        }
    };

    // Diff colors (`index.css` lines 2365-2366: `--diff-addition: var(--success)`,
    // `--diff-deletion: var(--destructive)`).
    let diff_added = success;
    let diff_added_background = color_mix_srgb(success, 0.12, Rgba::TRANSPARENT);
    let diff_removed = destructive;
    let diff_removed_background = color_mix_srgb(destructive, 0.12, Rgba::TRANSPARENT);

    Tokens {
        appearance: theme.appearance,
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
    }
}
