//! Bridges `conn_theme::Tokens` into GPUI colors and `gpui-kit`'s global theme.
//!
//! Views must never hardcode hex literals; every color is read from [`Tokens`]
//! via these helpers.

use conn_theme::{Appearance, Rgba as ThemeRgba, Tokens};
use gpui_kit::{App, Hsla, Rgba as GpuiRgba, px};

/// Converts a `conn_theme::Rgba` into a GPUI `Rgba`.
#[must_use]
pub(crate) fn gpui_rgba(color: ThemeRgba) -> GpuiRgba {
    GpuiRgba {
        r: color.r,
        g: color.g,
        b: color.b,
        a: color.a,
    }
}

/// Converts a `conn_theme::Rgba` into a GPUI `Hsla`.
#[must_use]
pub(crate) fn hsla(color: ThemeRgba) -> Hsla {
    Hsla::from(gpui_rgba(color))
}

/// Converts a `conn_theme::Rgba` into a GPUI `Hsla` with an overridden alpha.
#[must_use]
pub(crate) fn hsla_alpha(color: ThemeRgba, alpha: f32) -> Hsla {
    hsla(color.with_alpha(alpha))
}

/// Synchronizes `gpui-kit`'s global theme with Conn's active [`Tokens`] so
/// default kit colors and radii never leak into Conn surfaces.
/// The app's monospace family: JetBrains Mono (embedded and registered by `crate::fonts`).
pub(crate) const MONO_FONT: &str = "JetBrains Mono";

pub(crate) fn apply_kit_theme(tokens: &Tokens, cx: &mut App) {
    gpui_kit::component::Theme::update(cx, |theme| {
        theme.mode = match tokens.appearance {
            Appearance::Light => gpui_kit::component::ThemeMode::Light,
            Appearance::Dark => gpui_kit::component::ThemeMode::Dark,
        };
        theme.font_size = px(13.0);
        theme.mono_font_family = MONO_FONT.into();
        theme.radius = px(8.0);
        theme.radius_lg = px(14.0);
        theme.shadow = false;
        theme.cursor_blink = theme
            .cursor_blink
            .with_idle_timeout(std::time::Duration::from_secs(10));

        let c = &mut theme.colors;
        c.background = hsla(tokens.background);
        c.foreground = hsla(tokens.foreground);
        c.border = hsla(tokens.shell_divider);
        c.accent = hsla(tokens.shell_highlight);
        c.accent_foreground = hsla(tokens.accent_foreground);
        c.primary = hsla(tokens.primary);
        c.primary_foreground = hsla(tokens.primary_foreground);
        c.secondary = hsla(tokens.secondary);
        c.secondary_foreground = hsla(tokens.secondary_foreground);
        c.muted = hsla(tokens.muted);
        c.muted_foreground = hsla(tokens.muted_foreground);
        // Opaque: kit popups must not let content show through (Nick, #332).
        c.popover = hsla(tokens.shell_overlay.with_alpha(1.0));
        c.popover_foreground = hsla(tokens.popover_foreground);
        c.sidebar = hsla(tokens.shell_panel);
        c.sidebar_foreground = hsla(tokens.sidebar_foreground);
        c.sidebar_border = hsla(tokens.shell_divider);
        c.sidebar_accent = hsla(tokens.sidebar_row_hover);
        c.sidebar_accent_foreground = hsla(tokens.sidebar_foreground);
        c.danger = hsla(tokens.destructive);
        c.danger_foreground = hsla(tokens.destructive_foreground);
        c.warning = hsla(tokens.warning);
        c.warning_foreground = hsla(tokens.warning_foreground);
        c.info = hsla(tokens.info);
        c.info_foreground = hsla(tokens.info_foreground);
        c.success = hsla(tokens.success);
        c.success_foreground = hsla(tokens.success_foreground);
        c.ring = hsla(tokens.ring);
        c.input = hsla(tokens.shell_divider_header);
        c.caret = hsla(tokens.foreground);
    });
}
