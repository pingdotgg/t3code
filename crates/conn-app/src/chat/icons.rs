//! Bundled Phosphor icons for the chat timeline and composer.
//!
//! Mirrors `../conn/apps/web/src/icons/lucide-react.ts`: Phosphor fill weight by default,
//! and bold weight for carets, arrows, and checkmarks.

use std::borrow::Cow;
use std::fmt;

use gpui_kit::{AssetSource, Hsla, Result, SharedString, Styled as _, Svg, px, svg};
use rust_embed::RustEmbed;

/// Embedded Phosphor SVG icons under `assets/icons/phosphor/{fill,bold}/`.
///
/// Paths are exposed with a `phosphor/` prefix (e.g. `phosphor/fill/brain-fill.svg`)
/// so they never collide with `gpui_kit::assets::AllAssets`'s `icons/` Lucide paths.
#[derive(RustEmbed)]
#[folder = "assets/icons/phosphor"]
#[prefix = "phosphor/"]
#[include = "**/*.svg"]
pub(crate) struct PhosphorAssets;

impl fmt::Debug for PhosphorAssets {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PhosphorAssets").finish()
    }
}

impl AssetSource for PhosphorAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        if path.is_empty() {
            return Ok(None);
        }
        Ok(Self::get(path).map(|file| file.data))
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        Ok(Self::iter()
            .filter(|name| name.starts_with(path))
            .map(SharedString::from)
            .collect())
    }
}

/// Returns the [`AssetSource`] for bundled Phosphor timeline icons.
///
/// The orchestrator chains this with `gpui_kit::assets::AllAssets` when initializing GPUI.
#[must_use]
pub(crate) fn phosphor_assets() -> PhosphorAssets {
    PhosphorAssets
}

// Fill-weight timeline icons.
pub(super) const BRAIN: &str = "phosphor/fill/brain-fill.svg";
pub(super) const TERMINAL: &str = "phosphor/fill/terminal-window-fill.svg";
pub(super) const PENCIL: &str = "phosphor/fill/pencil-simple-fill.svg";
pub(super) const SEARCH: &str = "phosphor/fill/magnifying-glass-fill.svg";
pub(super) const GLOBE: &str = "phosphor/fill/globe-fill.svg";
pub(super) const PLUG: &str = "phosphor/fill/plug-fill.svg";
pub(super) const ROBOT: &str = "phosphor/fill/robot-fill.svg";
pub(super) const LIST_CHECKS: &str = "phosphor/fill/list-checks-fill.svg";
pub(super) const SHIELD_WARNING: &str = "phosphor/fill/shield-warning-fill.svg";
pub(super) const WARNING: &str = "phosphor/fill/warning-fill.svg";
pub(super) const INFO: &str = "phosphor/fill/info-fill.svg";
pub(super) const COPY: &str = "phosphor/fill/copy-fill.svg";
pub(super) const SPARKLE: &str = "phosphor/fill/sparkle-fill.svg";
pub(super) const SQUARE: &str = "phosphor/fill/square-fill.svg";
pub(super) const CHAT_CIRCLE: &str = "phosphor/fill/chat-circle-fill.svg";

// Bold-weight carets and line glyphs.
pub(super) const CARET_RIGHT: &str = "phosphor/bold/caret-right-bold.svg";
pub(super) const CARET_DOWN: &str = "phosphor/bold/caret-down-bold.svg";
pub(super) const ARROW_UP: &str = "phosphor/bold/arrow-up-bold.svg";
pub(super) const CHECK: &str = "phosphor/bold/check-bold.svg";

/// Returns the Phosphor icon asset path for a `TimelineEntry::Tool` kind.
pub(super) fn tool_icon_path(kind: &str) -> &'static str {
    match kind {
        "command" => TERMINAL,
        "file_change" => PENCIL,
        "file_search" => SEARCH,
        "web_search" => GLOBE,
        "subagent" => ROBOT,
        "todo_list" => LIST_CHECKS,
        "approval" | "secret_request" | "link_request" => SHIELD_WARNING,
        _ => PLUG,
    }
}

/// Renders a Phosphor SVG icon at `size_px` tinted with `color`.
pub(super) fn icon(path: &'static str, size_px: f32, color: Hsla) -> Svg {
    svg()
        .path(path)
        .size(px(size_px))
        .text_color(color)
        .flex_none()
}
