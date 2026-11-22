//! Fonts the app registers at launch.
//!
//! Conn's `--font-mono` is `ui-monospace`, which macOS resolves to SF Mono. The system copy is
//! a private family GPUI cannot name, but Terminal.app ships SF Mono as ordinary font files.
//! Register those, so code, inline code and terminals draw in SF Mono as in Conn; without them
//! the app falls back to Menlo, Conn's next choice.

use gpui_kit::App;

const SF_MONO_DIR: &str = "/System/Applications/Utilities/Terminal.app/Contents/Resources/Fonts";
const SF_MONO_FILES: &[&str] = &[
    "SF-Mono-Regular.otf",
    "SF-Mono-RegularItalic.otf",
    "SF-Mono-Medium.otf",
    "SF-Mono-Semibold.otf",
    "SF-Mono-Bold.otf",
];

/// Registers SF Mono. Returns false when it could not (the app then shows Menlo-like
/// fallback glyphs for [`crate::theme::MONO_FONT`]).
pub(crate) fn register(cx: &mut App) -> bool {
    let fonts: Vec<std::borrow::Cow<'static, [u8]>> = SF_MONO_FILES
        .iter()
        .filter_map(|name| std::fs::read(format!("{SF_MONO_DIR}/{name}")).ok())
        .map(std::borrow::Cow::Owned)
        .collect();
    if fonts.is_empty() {
        eprintln!("fonts: SF Mono not found in {SF_MONO_DIR}");
        return false;
    }
    match cx.text_system().add_fonts(fonts) {
        Ok(()) => true,
        Err(error) => {
            eprintln!("fonts: could not register SF Mono: {error}");
            false
        }
    }
}
