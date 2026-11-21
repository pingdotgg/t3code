//! UI chrome icons for the Conn window shell (superheroicons 16/solid).
//!
//! Every icon resolves through [`crate::superhero::AppAssets`] to a 16/solid
//! superheroicons SVG (`assets/icons/superhero/16/solid/`):
//! - `IconName::*` via gpui-kit's `Icon` component (mapped by `manifest.json`).
//! - Direct superhero concept paths (`superhero/<concept>.svg`) via [`concept`].
//!
//! Standard sizes match Conn (`apps/web`):
//! - `16px` (`size-4`) for chrome buttons, rail icons, and header actions.
//! - `14px` (`size-3.5`) for compact inline provider and status indicators.
//! - `12px` (`size-3`) for disclosure carets.

use conn_state::RightPanelTab;
use gpui_kit::assets::IconName;
use gpui_kit::component::Icon;
use gpui_kit::{Hsla, Styled as _, Svg, px, svg};

/// Standard chrome icon size (`size-4` = 16px).
pub(crate) const CHROME_ICON_PX: f32 = 16.0;
/// Disclosure chevron / tree caret size (`size-3` = 12px).
pub(crate) const CARET_ICON_PX: f32 = 12.0;

/// Superhero concept path for `SquareMenu` (thread details / notes button in `ChatHeader`).
pub(crate) const PANEL_MENU: &str = "superhero/panel-menu.svg";
/// Superhero concept path for `PanelBottom` (terminal drawer toggle in `PanelLayoutControls`).
pub(crate) const PANEL_BOTTOM: &str = "superhero/panel-bottom.svg";
/// Superhero concept path for `PanelRight` (right panel toggle in `PanelLayoutControls`).
pub(crate) const SIDEBAR_RIGHT: &str = "superhero/sidebar-right.svg";
/// Superhero concept path for `GitPullRequestArrow` (Pull Requests button in `WorkspaceRail`).
pub(crate) const PULL_REQUEST: &str = "superhero/pull-request.svg";

/// Creates a 16px chrome icon tinted with `color`.
#[must_use]
pub(crate) fn chrome(name: IconName, color: Hsla) -> Icon {
    sized(name, CHROME_ICON_PX, color)
}

/// Creates an icon at an explicit pixel size tinted with `color`.
#[must_use]
pub(crate) fn sized(name: IconName, size_px: f32, color: Hsla) -> Icon {
    Icon::new(name).size(px(size_px)).text_color(color)
}

/// Renders a superheroicons SVG concept path (`"superhero/<concept>.svg"`) at
/// `size_px` tinted with `color`.
#[must_use]
pub(crate) fn concept(path: &'static str, size_px: f32, color: Hsla) -> Svg {
    svg()
        .path(path)
        .size(px(size_px))
        .text_color(color)
        .flex_none()
}

/// Maps a Conn Lucide project-icon name (from `ProjectProjectIcon::Lucide.name`)
/// to its superheroicons 16/solid concept path (`manifest.json`).
#[must_use]
pub(crate) fn project_lucide_concept(name: &str) -> &'static str {
    match name.to_ascii_lowercase().as_str() {
        "lightbulb" | "idea" => "superhero/idea.svg",
        "code" | "code-2" => "superhero/code.svg",
        "terminal" => "superhero/terminal.svg",
        "rocket" => "superhero/rocket.svg",
        "server" => "superhero/server.svg",
        "database" => "superhero/database.svg",
        "smartphone" => "superhero/phone.svg",
        "globe" => "superhero/globe.svg",
        "book" | "book-open" => "superhero/book.svg",
        "flask-conical" | "flask" => "superhero/tests.svg",
        "palette" => "superhero/theme.svg",
        "users" => "superhero/users.svg",
        "building" => "superhero/building.svg",
        "house" | "home" => "superhero/home.svg",
        "star" => "superhero/star.svg",
        "heart" => "superhero/heart.svg",
        "zap" => "superhero/fast.svg",
        "coffee" => "superhero/coffee.svg",
        "briefcase" => "superhero/briefcase.svg",
        "folder-code" => "superhero/folder-code.svg",
        "folder-git" | "folder-git-2" => "superhero/folder-git.svg",
        _ => "superhero/folder.svg",
    }
}

/// Creates a 12px disclosure caret tinted with `color`.
#[must_use]
pub(crate) fn caret(expanded: bool, color: Hsla) -> Icon {
    let name = if expanded {
        IconName::ChevronDown
    } else {
        IconName::ChevronRight
    };
    sized(name, CARET_ICON_PX, color)
}

/// Returns the icon for a right-panel tab.
#[must_use]
pub(crate) fn right_panel_tab_icon(tab: RightPanelTab) -> IconName {
    match tab {
        RightPanelTab::Files => IconName::Folder,
        RightPanelTab::Diff => IconName::GitPullRequest,
        RightPanelTab::Terminal => IconName::Terminal,
        RightPanelTab::Browser => IconName::Globe,
        RightPanelTab::Api => IconName::Globe,
        RightPanelTab::Database => IconName::Database,
        RightPanelTab::Mcp => IconName::Plug,
        RightPanelTab::Tasks => IconName::Check,
        RightPanelTab::PullRequest => IconName::GitPullRequest,
        RightPanelTab::LinkedItems => IconName::ExternalLink,
        RightPanelTab::Device => IconName::Smartphone,
    }
}

/// The brand mark Conn shows for a provider (driver or instance id such as `claudeAgent`,
/// `codex`): the Claude starburst in Claude orange, the OpenAI knot in `fallback` color, else
/// a generic superheroicons agent glyph.
pub(crate) fn provider_mark(provider: &str, size_px: f32, fallback: Hsla) -> Svg {
    let lower = provider.to_ascii_lowercase();
    let (path, color): (&'static str, Hsla) = if lower.contains("claude")
        || lower.contains("anthropic")
        || lower.contains("haiku")
        || lower.contains("sonnet")
        || lower.contains("opus")
    {
        (
            "brand/claude.svg",
            crate::theme::hsla(conn_theme::CLAUDE_BRAND),
        )
    } else if lower.contains("codex") || lower.contains("openai") || lower.contains("gpt") {
        ("brand/openai.svg", fallback)
    } else {
        ("superhero/agent.svg", fallback)
    };
    svg()
        .path(path)
        .size(px(size_px))
        .text_color(color)
        .flex_none()
}
