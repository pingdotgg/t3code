//! Color conversion helpers bridging [`conn_theme::Rgba`] and GPUI colors.
//!
//! Views in `panels` never embed hex literals; every color is derived from
//! [`conn_theme::Tokens`].

use conn_theme::Rgba;
use gpui_kit::Hsla;

/// 8-bit sRGB triple used by the terminal grid renderer.
pub(crate) type Rgb8 = (u8, u8, u8);

/// Converts a [`conn_theme::Rgba`] token into a GPUI [`Hsla`].
#[must_use]
pub(crate) fn to_hsla(c: Rgba) -> Hsla {
    Hsla::from(gpui_kit::Rgba {
        r: c.r,
        g: c.g,
        b: c.b,
        a: c.a,
    })
}

/// Converts a [`conn_theme::Rgba`] token into an 8-bit RGB triple (ignoring alpha).
#[must_use]
pub(crate) fn to_rgb8(c: Rgba) -> Rgb8 {
    (
        (c.r.clamp(0.0, 1.0) * 255.0).round() as u8,
        (c.g.clamp(0.0, 1.0) * 255.0).round() as u8,
        (c.b.clamp(0.0, 1.0) * 255.0).round() as u8,
    )
}

/// Converts an 8-bit RGB triple into an opaque GPUI [`Hsla`].
#[must_use]
pub(crate) fn rgb8_to_hsla((r, g, b): Rgb8) -> Hsla {
    Hsla::from(gpui_kit::Rgba {
        r: f32::from(r) / 255.0,
        g: f32::from(g) / 255.0,
        b: f32::from(b) / 255.0,
        a: 1.0,
    })
}

/// Linearly blends two 8-bit RGB colors in sRGB (`weight_a` in `0.0..=1.0`).
#[must_use]
pub(crate) fn mix_rgb8(a: Rgb8, weight_a: f32, b: Rgb8) -> Rgb8 {
    let w = weight_a.clamp(0.0, 1.0);
    let inv = 1.0 - w;
    let channel = |ca: u8, cb: u8| (f32::from(ca) * w + f32::from(cb) * inv).round() as u8;
    (channel(a.0, b.0), channel(a.1, b.1), channel(a.2, b.2))
}
