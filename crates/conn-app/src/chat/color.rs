//! Color conversions from `conn_theme::Rgba` to GPUI `Hsla` and theme-derived
//! syntax highlight colors. No hex literals belong in chat views.

use conn_theme::{Rgba, Tokens};
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
