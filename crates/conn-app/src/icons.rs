//! Lucide UI chrome icons for the Conn window shell.
//!
//! All shell chrome (workspace rail, sidebar, 44px header, right-panel tabs)
//! uses Lucide icons via `gpui-kit`'s bundled `AllAssets` at 16px (`size-4`),
//! with 12px (`size-3`) for disclosure carets.

use conn_state::RightPanelTab;
use gpui_kit::assets::IconName;
use gpui_kit::component::Icon;
use gpui_kit::{Hsla, Styled as _, px};

/// Standard chrome icon size (`size-4` = 16px).
pub(crate) const CHROME_ICON_PX: f32 = 16.0;
/// Disclosure chevron / tree caret size (`size-3` = 12px).
pub(crate) const CARET_ICON_PX: f32 = 12.0;

/// Creates a 16px Lucide chrome icon tinted with `color`.
#[must_use]
pub(crate) fn chrome(name: IconName, color: Hsla) -> Icon {
    Icon::new(name).size(px(CHROME_ICON_PX)).text_color(color)
}

/// Creates a 12px Lucide disclosure caret tinted with `color`.
#[must_use]
pub(crate) fn caret(expanded: bool, color: Hsla) -> Icon {
    let name = if expanded {
        IconName::ChevronDown
    } else {
        IconName::ChevronRight
    };
    Icon::new(name).size(px(CARET_ICON_PX)).text_color(color)
}

/// Returns the Lucide icon for a right-panel tab.
#[must_use]
pub(crate) fn right_panel_tab_icon(tab: RightPanelTab) -> IconName {
    match tab {
        RightPanelTab::Files => IconName::Folder,
        RightPanelTab::Diff => IconName::GitPullRequest,
        RightPanelTab::Terminal => IconName::Terminal,
        RightPanelTab::Browser => IconName::Globe,
        RightPanelTab::Database => IconName::Database,
        RightPanelTab::Mcp => IconName::Plug,
        RightPanelTab::Device => IconName::Smartphone,
    }
}
