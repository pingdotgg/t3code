//! Timeline and composer icons: superheroicons 16/solid concepts (`crate::superhero`).
//!
//! Conn draws every icon, timeline included, from superheroicons (decision
//! `conn-icon-set-solid-v4`); the Lucide/Phosphor split in `lucide-react.ts` is history.

use std::borrow::Cow;

use conn_state::conn_tools::{ConnToolIcon, conn_tool_presentation};
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

/// The Conn brand mark (`ConnMark`), drawn for Conn MCP tools that have no more specific icon.
pub(super) const CONN_MARK: &str = "brand/conn-mark.svg";
const PULL_REQUEST: &str = "superhero/pull-request.svg";
const DEVICE: &str = "superhero/phone.svg";
const KEY: &str = "superhero/key.svg";

fn conn_icon_path(icon: ConnToolIcon) -> &'static str {
    match icon {
        ConnToolIcon::ConnMark => CONN_MARK,
        ConnToolIcon::Browser => GLOBE,
        ConnToolIcon::Device => DEVICE,
        ConnToolIcon::PullRequest => PULL_REQUEST,
        ConnToolIcon::Credential => KEY,
    }
}

/// Title to show for a tool row. A Conn MCP tool call (`mcp__conn__conn_thread_send`, any provider
/// spelling, or the pre-rename `t3` forms) gets Conn's friendly label; other rows keep their title.
pub(super) fn tool_display_title<'a>(kind: &str, title: &'a str) -> Cow<'a, str> {
    if is_fixed_kind(kind) {
        return Cow::Borrowed(title);
    }
    match conn_tool_presentation(title) {
        Some(found) => found.display_name,
        None => Cow::Borrowed(title),
    }
}

/// Kinds the server types itself; their title is not an MCP tool name.
fn is_fixed_kind(kind: &str) -> bool {
    matches!(
        kind,
        "command"
            | "file_change"
            | "file_read"
            | "read"
            | "file_search"
            | "web_search"
            | "subagent"
            | "todo_list"
            | "thread_created"
            | "approval"
            | "secret_request"
            | "link_request"
    )
}

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
        _ => conn_tool_presentation(title)
            .map(|found| conn_icon_path(found.icon))
            .or_else(|| infer_tool_icon_from_title(title))
            .unwrap_or(if kind == "dynamic_tool" { BUILD } else { TOOL }),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conn_mcp_tools_pick_web_icons() {
        let cases: &[(&str, &str)] = &[
            // Claude: mcp__<server>__<tool>, legacy and renamed server and tool prefixes.
            ("mcp__t3-code__t3_thread_send", CONN_MARK),
            ("mcp__t3-code__delegate_task", CONN_MARK),
            ("mcp__t3-code__create_threads", CONN_MARK),
            ("mcp__conn__conn_thread_send", CONN_MARK),
            ("mcp__conn__conn_thread_launch", CONN_MARK),
            ("mcp__CONN__conn_queue", CONN_MARK),
            ("mcp__t3-code__html_render", CONN_MARK),
            ("mcp__t3-code__request_secret", CONN_MARK),
            // A Conn tool the table does not know yet still gets the Conn mark.
            ("mcp__conn__conn_brand_new_tool", CONN_MARK),
            // Pull requests and CI.
            ("mcp__t3-code__pull_request_create", PULL_REQUEST),
            ("mcp__conn__link_pull_request", PULL_REQUEST),
            ("mcp__t3-code__watch_pull_request", PULL_REQUEST),
            ("mcp__t3-code__ci_logs", PULL_REQUEST),
            // Browser, annotations, devices, credentials.
            ("mcp__t3-code__preview_open", GLOBE),
            ("mcp__t3-code__preview_act", GLOBE),
            ("mcp__t3-code__t3_preview_list", GLOBE),
            ("mcp__conn__conn_preview_close", GLOBE),
            ("mcp__t3-code__annotations_claim", GLOBE),
            ("mcp__t3-code__device_open", DEVICE),
            ("mcp__t3-code__device_screenshot", DEVICE),
            ("mcp__t3-code__fill_credential", KEY),
            ("mcp__t3-code__save_test_login", KEY),
            // Other providers' spellings.
            ("t3-code.t3_thread_send", CONN_MARK),
            ("conn.conn_thread_read", CONN_MARK),
            ("conn-direct.pull_request_merge", PULL_REQUEST),
            ("t3-code:device_list", DEVICE),
            ("t3-code · t3_thread_list", CONN_MARK),
            ("t3_thread_send", CONN_MARK),
            ("conn_thread_send", CONN_MARK),
            ("pull_request_read", PULL_REQUEST),
            ("conn-my_thread_conn_thread_send", CONN_MARK),
            ("t3-code-abc_preview_open", GLOBE),
            ("mcp__t3-code__t3_thread_send completed", CONN_MARK),
            ("mcp__t3-code__pull_request_create complete", PULL_REQUEST),
        ];
        for (title, expected) in cases {
            assert_eq!(
                tool_icon_path("dynamic_tool", title),
                *expected,
                "title {title:?}"
            );
        }
    }

    #[test]
    fn other_tools_keep_their_icons() {
        let cases: &[(&str, &str, &str)] = &[
            ("dynamic_tool", "mcp__github__create_issue", BUILD),
            ("dynamic_tool", "mcp__other__t3_thread_send", BUILD),
            ("dynamic_tool", "Tool call", BUILD),
            ("dynamic_tool", "Read src/main.rs", EYE),
            ("mcp", "mcp__other__lookup", TOOL),
            ("command", "ls -la", TERMINAL),
            ("thread_created", "Created thread", THREAD),
            ("file_change", "Changed a.rs", PENCIL),
        ];
        for (kind, title, expected) in cases {
            assert_eq!(
                tool_icon_path(kind, title),
                *expected,
                "kind {kind:?} title {title:?}"
            );
        }
    }

    #[test]
    fn conn_tool_rows_show_the_friendly_label() {
        let cases: &[(&str, &str, &str)] = &[
            (
                "dynamic_tool",
                "Mcp__conn__conn_thread_send",
                "Send to a Conn thread",
            ),
            (
                "mcp",
                "mcp__conn__pull_request_create",
                "Open a pull request",
            ),
            (
                "dynamic_tool",
                "mcp__t3-code__t3_thread_list",
                "List Conn threads",
            ),
            ("dynamic_tool", "conn.conn_queue", "Manage queued messages"),
            // Other tools and typed kinds keep their title.
            (
                "dynamic_tool",
                "mcp__github__create_issue",
                "mcp__github__create_issue",
            ),
            ("dynamic_tool", "Read src/main.rs", "Read src/main.rs"),
            ("command", "conn_thread_send", "conn_thread_send"),
        ];
        for (kind, title, expected) in cases {
            assert_eq!(
                tool_display_title(kind, title),
                *expected,
                "kind {kind:?} title {title:?}"
            );
        }
    }

    #[test]
    fn conn_mark_asset_is_embedded() {
        use gpui_kit::AssetSource as _;
        let bytes = crate::superhero::AppAssets
            .load(CONN_MARK)
            .expect("asset lookup")
            .expect("brand/conn-mark.svg must be embedded");
        assert!(bytes.starts_with(b"<svg"));
    }
}
