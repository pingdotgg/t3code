//! Timeline and composer icons: superheroicons 16/solid concepts (`crate::superhero`).
//!
//! Conn draws every icon, timeline included, from superheroicons (decision
//! `conn-icon-set-solid-v4`); the Lucide/Phosphor split in `lucide-react.ts` is history.

use gpui_kit::{Hsla, Styled as _, Svg, px, svg};

// Timeline icons.
pub(super) const BRAIN: &str = "superhero/thinking.svg";
pub(super) const TERMINAL: &str = "superhero/terminal-window.svg";
pub(super) const PENCIL: &str = "superhero/edit.svg";
pub(super) const SEARCH: &str = "superhero/search.svg";
pub(super) const GLOBE: &str = "superhero/globe.svg";
pub(super) const PLUG: &str = "superhero/plug.svg";
pub(super) const ROBOT: &str = "superhero/agent.svg";
pub(super) const LIST_CHECKS: &str = "superhero/checklist.svg";
pub(super) const SHIELD_WARNING: &str = "superhero/needs-approval.svg";
pub(super) const WARNING: &str = "superhero/warning.svg";
pub(super) const INFO: &str = "superhero/info.svg";
pub(super) const COPY: &str = "superhero/copy.svg";
pub(super) const SQUARE: &str = "superhero/stop.svg";
pub(super) const CHAT_CIRCLE: &str = "superhero/comment.svg";

// Carets and line glyphs.
pub(super) const CARET_RIGHT: &str = "superhero/chevron-right.svg";
pub(super) const CARET_DOWN: &str = "superhero/chevron-down.svg";
pub(super) const ARROW_UP: &str = "superhero/arrow-up.svg";
pub(super) const CHECK: &str = "superhero/check.svg";

/// Returns the icon asset path for a `TimelineEntry::Tool` kind.
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
