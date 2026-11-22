//! Timeline and composer icons: superheroicons 16/solid concepts (`crate::superhero`).
//!
//! Conn draws every icon, timeline included, from superheroicons (decision
//! `conn-icon-set-solid-v4`); the Lucide/Phosphor split in `lucide-react.ts` is history.

use gpui_kit::{Hsla, Styled as _, Svg, px, svg};

// Timeline icons (mapped from Conn's Lucide names via superheroicons manifest.json).
pub(super) const BRAIN: &str = "superhero/thinking.svg";
pub(super) const TERMINAL: &str = "superhero/terminal.svg";
pub(super) const PENCIL: &str = "superhero/compose.svg";
pub(super) const EYE: &str = "superhero/show.svg";
pub(super) const SEARCH: &str = "superhero/search.svg";
pub(super) const GLOBE: &str = "superhero/globe.svg";
pub(super) const BUILD: &str = "superhero/build.svg";
pub(super) const TOOL: &str = "superhero/tool.svg";
pub(super) const ROBOT: &str = "superhero/agent.svg";
pub(super) const LIST_CHECKS: &str = "superhero/checklist.svg";
pub(super) const THREAD: &str = "superhero/thread.svg";
pub(super) const SHIELD: &str = "superhero/shield.svg";
pub(super) const SHIELD_WARNING: &str = "superhero/needs-approval.svg";
pub(super) const ERROR_CIRCLE: &str = "superhero/error-circle.svg";
pub(super) const INFO: &str = "superhero/info.svg";
pub(super) const COPY: &str = "superhero/copy.svg";
pub(super) const SQUARE: &str = "superhero/stop.svg";
pub(super) const CHAT_CIRCLE: &str = "superhero/comment.svg";

// Carets and line glyphs.
pub(super) const CARET_RIGHT: &str = "superhero/chevron-right.svg";
pub(super) const CARET_DOWN: &str = "superhero/chevron-down.svg";
pub(super) const ARROW_UP: &str = "superhero/arrow-up.svg";
pub(super) const FORWARD: &str = "superhero/forward.svg";
pub(super) const CHECK: &str = "superhero/check.svg";
pub(super) const EDIT: &str = "superhero/edit.svg";
pub(super) const CLOSE: &str = "superhero/close.svg";
pub(super) const IMAGE: &str = "superhero/image.svg";

// Card and hover-action glyphs (Lucide name -> superheroicons concept via manifest.json).
/// `Redo2` (Conn's `Steer` marker).
pub(super) const REDO: &str = "superhero/redo.svg";
/// `GitFork` (`Fork from this response`).
pub(super) const FORK: &str = "superhero/fork.svg";
/// `Minus` (declined secret request).
pub(super) const MINUS: &str = "superhero/remove.svg";
/// `Lock` (secret pending in another thread).
pub(super) const LOCK: &str = "superhero/lock.svg";
/// `ShieldCheck` (secret privacy note).
pub(super) const SHIELD_CHECK: &str = "superhero/shield-check.svg";
/// `FileDiff` (`Open diff`).
pub(super) const FILE_DIFF: &str = "superhero/file-diff.svg";
/// `ChevronsUpDown` (`Expand all folders`).
pub(super) const CHEVRONS_UP_DOWN: &str = "superhero/chevrons-up-down.svg";
/// `ChevronsDownUp` (`Collapse all folders`).
pub(super) const CHEVRONS_DOWN_UP: &str = "superhero/chevrons-down-up.svg";
/// `ExternalLink` (secret sign-in page).
pub(super) const EXTERNAL_LINK: &str = "superhero/external-link.svg";

/// Returns the superheroicons asset path for a `TimelineEntry::Tool` using both its
/// contract `kind` and human-readable `title` (matching Conn's `toolGroupAction`).
pub(super) fn tool_icon_path(kind: &str, title: &str) -> &'static str {
    match kind {
        "command" => TERMINAL,
        "file_change" => PENCIL,
        "file_read" | "read" => EYE,
        "file_search" => SEARCH,
        "web_search" => GLOBE,
        "subagent" => ROBOT,
        "todo_list" => LIST_CHECKS,
        "thread_created" => THREAD,
        "approval" | "secret_request" | "link_request" => SHIELD_WARNING,
        _ => infer_tool_icon_from_title(title).unwrap_or(if kind == "dynamic_tool" {
            BUILD
        } else {
            TOOL
        }),
    }
}

fn infer_tool_icon_from_title(title: &str) -> Option<&'static str> {
    let lower = title.trim().to_ascii_lowercase();
    if lower.starts_with("read ")
        || lower.starts_with("view ")
        || lower.starts_with("inspect ")
        || lower == "read file"
    {
        Some(EYE)
    } else if lower.starts_with("edit ")
        || lower.starts_with("write ")
        || lower.starts_with("create ")
        || lower.starts_with("update ")
        || lower.starts_with("patch ")
        || lower.starts_with("delete ")
    {
        Some(PENCIL)
    } else if lower.starts_with("ran ")
        || lower.starts_with("run ")
        || lower.starts_with("exec ")
        || lower.starts_with("shell ")
    {
        Some(TERMINAL)
    } else if lower.starts_with("search ")
        || lower.starts_with("find ")
        || lower.starts_with("grep ")
        || lower.starts_with("glob ")
        || lower.starts_with("list ")
    {
        Some(SEARCH)
    } else if lower.starts_with("web ") || lower.starts_with("fetch ") {
        Some(GLOBE)
    } else if lower.starts_with("subagent") || lower.starts_with("delegate") {
        Some(ROBOT)
    } else {
        None
    }
}

/// Renders a superheroicons SVG icon at `size_px` tinted with `color`.
pub(super) fn icon(path: &'static str, size_px: f32, color: Hsla) -> Svg {
    svg()
        .path(path)
        .size(px(size_px))
        .text_color(color)
        .flex_none()
}
