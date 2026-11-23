//! Color conversions from `conn_theme::Rgba` to GPUI `Hsla` and theme-derived
//! syntax highlight colors. No hex literals belong in chat views.

use conn_theme::{Rgba, Tokens, color_mix_oklab};
use gpui_kit::{Hsla, Rgba as GpuiRgba};

/// Converts a `conn_theme::Rgba` into a GPUI `Hsla`.
pub(super) fn hsla(color: Rgba) -> Hsla {
    GpuiRgba {
        r: color.r,
        g: color.g,
        b: color.b,
        a: color.a,
    }
    .into()
}

/// Converts a `conn_theme::Rgba` into a GPUI `Hsla` with an overridden alpha.
pub(super) fn hsla_alpha(color: Rgba, alpha: f32) -> Hsla {
    hsla(color.with_alpha(alpha))
}

/// The same colour with its alpha dropped: the opaque form of a glass fill. GPUI has no backdrop
/// blur (gpui-kit#3598), so surfaces that web draws as translucent glass over a blur stay opaque
/// until one ships (Nick, 2026-11-23).
pub(super) fn opaque(color: Rgba) -> Hsla {
    hsla(color.with_alpha(1.0))
}

/// `fill` painted over the opaque `base` (source-over in sRGB, as GPUI composites): the colour
/// the eye sees where a translucent card sits on the page.
pub(super) fn composite_over(fill: Rgba, base: Rgba) -> Rgba {
    let a = fill.a.clamp(0.0, 1.0);
    let mix = |f: f32, b: f32| f * a + b * (1.0 - a);
    Rgba::new(
        mix(fill.r, base.r),
        mix(fill.g, base.g),
        mix(fill.b, base.b),
        1.0,
    )
}

/// The ends of a fade-out over text that sits on `surface`: the opaque surface where the text is
/// hidden, and the same colour at zero alpha where it shows. Ending anywhere else paints a band
/// of a different colour than the card behind it.
pub(super) fn fade_ends(surface: Rgba) -> (Hsla, Hsla) {
    (hsla(surface.with_alpha(1.0)), hsla(surface.with_alpha(0.0)))
}

/// The page the chat cards sit on: the chat pane's opaque `shell_card`.
pub(super) fn chat_page(tokens: &Tokens) -> Rgba {
    tokens.shell_card.with_alpha(1.0)
}

/// Top-edge highlight of the user's chat bubble matching Conn's `--message-highlight`:
/// `color-mix(in oklab, var(--message-surface) 90%, var(--foreground))`.
pub(super) fn message_highlight(tokens: &Tokens) -> Hsla {
    hsla(color_mix_oklab(
        tokens.message_surface,
        0.90,
        tokens.foreground,
    ))
}

/// `ComposerBanner.Root`'s default surface and outline (`--chat-composer-attached-surface`,
/// `--chat-composer-attached-outline`).
pub(super) fn banner_surface(tokens: &Tokens) -> (Hsla, Hsla) {
    (hsla(tokens.shell_raised), hsla(tokens.shell_inner_border))
}

/// Assistant prose foreground matching Conn's `text-foreground/90`.
pub(super) fn prose_foreground(tokens: &Tokens) -> Hsla {
    hsla_alpha(tokens.foreground, 0.90)
}

/// Muted work-log icon color matching Conn's `text-icon-muted opacity-70`.
pub(super) fn muted_icon(tokens: &Tokens) -> Hsla {
    hsla_alpha(tokens.muted_foreground, 0.70)
}

/// Semantic syntax-highlighting role mapped onto active theme tokens at paint time.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum SyntaxRole {
    Plain,
    Comment,
    String,
    Keyword,
    Function,
    Type,
    Number,
    Constant,
    Operator,
}

impl SyntaxRole {
    /// Resolves this syntax role to a GPUI color derived from `tokens`.
    pub(super) fn color(self, tokens: &Tokens) -> Hsla {
        match self {
            Self::Plain => hsla(tokens.code_foreground),
            Self::Comment => hsla(tokens.muted_foreground),
            Self::String => hsla(tokens.success),
            Self::Keyword => hsla(tokens.primary),
            Self::Function => hsla(tokens.info),
            Self::Type => hsla(tokens.warning),
            Self::Number | Self::Constant => hsla(tokens.destructive),
            Self::Operator => hsla_alpha(tokens.code_foreground, 0.78),
        }
    }
}

#[cfg(test)]
mod opaque_tests {
    use super::{hsla, opaque};
    use conn_theme::{Tokens, builtin_themes};

    /// Every popover and menu fill is opaque in every built-in theme, and `opaque` keeps the
    /// colour of the glass fill it replaces.
    #[test]
    fn popover_and_glass_fills_are_opaque_in_every_theme() {
        for theme in builtin_themes() {
            let tokens = Tokens::derive(&theme);
            assert_eq!(hsla(tokens.popover).a, 1.0, "{} popover", theme.id);
            let glass = opaque(tokens.shell_overlay);
            assert_eq!(glass.a, 1.0, "{} shell_overlay", theme.id);
            let translucent = hsla(tokens.shell_overlay);
            assert!(
                (glass.h - translucent.h).abs() < 1e-4 && (glass.l - translucent.l).abs() < 1e-4,
                "{} keeps the colour",
                theme.id
            );
        }
    }
}
