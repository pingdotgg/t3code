//! Fonts the app registers at launch.
//!
//! The app's monospace font is JetBrains Mono (SIL Open Font License 1.1, see
//! `assets/fonts/jetbrains-mono/OFL.txt`), embedded in the binary like the icon sets so code,
//! inline code, diffs and terminals look the same on every Mac, installed copy or not.

use std::borrow::Cow;

use gpui_kit::App;
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "assets/fonts/jetbrains-mono"]
#[include = "*.ttf"]
struct JetBrainsMono;

pub(crate) mod axes;

/// The embedded faces of `family` (JetBrains Mono only), as font files.
pub(crate) fn bundled_faces(family: &str) -> Vec<Cow<'static, [u8]>> {
    if !family.trim().eq_ignore_ascii_case(crate::theme::MONO_FONT) {
        return Vec::new();
    }
    JetBrainsMono::iter()
        .filter_map(|name| JetBrainsMono::get(&name))
        .map(|file| file.data)
        .collect()
}

/// Registers JetBrains Mono. Returns false when it could not (the app then shows fallback
/// glyphs for [`crate::theme::MONO_FONT`]).
pub(crate) fn register(cx: &mut App) -> bool {
    let fonts: Vec<Cow<'static, [u8]>> = JetBrainsMono::iter()
        .filter_map(|name| JetBrainsMono::get(&name))
        .map(|file| file.data)
        .collect();
    match cx.text_system().add_fonts(fonts) {
        Ok(()) => true,
        Err(error) => {
            eprintln!("fonts: could not register JetBrains Mono: {error}");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::JetBrainsMono;
    use crate::theme::MONO_FONT;

    /// The headless test platform has no real text system, so check what the registration feeds
    /// it: every embedded face carries the family name `MONO_FONT` asks for.
    #[test]
    fn embedded_faces_are_the_mono_family() {
        let faces: Vec<_> = JetBrainsMono::iter()
            .filter(|name| name.ends_with(".ttf"))
            .collect();
        assert_eq!(
            faces.len(),
            2,
            "the variable upright and italic faces (`wght` axis, v2.304)"
        );
        for name in faces {
            let Some(file) = JetBrainsMono::get(&name) else {
                panic!("{name} listed but not embedded");
            };
            // The name table stores Windows names as UTF-16BE.
            let wide: Vec<u8> = MONO_FONT
                .encode_utf16()
                .flat_map(u16::to_be_bytes)
                .collect();
            assert!(
                file.data.windows(wide.len()).any(|w| w == wide.as_slice()),
                "{name} does not carry the family name {MONO_FONT}"
            );
        }
    }
}
