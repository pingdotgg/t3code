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
