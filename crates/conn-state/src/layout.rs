/// Minimum sidebar width in CSS pixels.
pub const SIDEBAR_MIN_WIDTH: f32 = 153.0;
/// Maximum sidebar width in CSS pixels.
pub const SIDEBAR_MAX_WIDTH: f32 = 480.0;
/// Default sidebar width in CSS pixels.
pub const SIDEBAR_DEFAULT_WIDTH: f32 = 233.0;

/// Minimum right-panel width in CSS pixels.
pub const RIGHT_PANEL_MIN_WIDTH: f32 = 320.0;
/// Maximum right-panel width in CSS pixels.
pub const RIGHT_PANEL_MAX_WIDTH: f32 = 1200.0;
/// Default right-panel width in CSS pixels.
pub const RIGHT_PANEL_DEFAULT_WIDTH: f32 = 480.0;

/// Top-level right-panel surface tabs matching Conn desktop (`RightPanelTabs.tsx`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RightPanelTab {
    Files,
    Diff,
    Terminal,
    Browser,
    Database,
    Mcp,
    Device,
}

/// Window layout state: sidebar, right panel, and selection.
#[derive(Clone, Debug, PartialEq)]
pub struct LayoutState {
    pub sidebar_open: bool,
    pub sidebar_width: f32,
    pub right_panel_open: bool,
    pub right_panel_width: f32,
    pub right_panel_tab: RightPanelTab,
    pub selected_project_id: Option<String>,
    pub selected_thread_id: Option<String>,
}

impl Default for LayoutState {
    fn default() -> Self {
        Self {
            sidebar_open: true,
            sidebar_width: SIDEBAR_DEFAULT_WIDTH,
            right_panel_open: false,
            right_panel_width: RIGHT_PANEL_DEFAULT_WIDTH,
            right_panel_tab: RightPanelTab::Files,
            selected_project_id: None,
            selected_thread_id: None,
        }
    }
}

impl LayoutState {
    /// Toggles sidebar visibility.
    pub fn toggle_sidebar(&mut self) {
        self.sidebar_open = !self.sidebar_open;
    }

    /// Toggles right-panel visibility without changing the active tab.
    pub fn toggle_right_panel(&mut self) {
        self.right_panel_open = !self.right_panel_open;
    }

    /// Opens the right panel on `tab`, or closes it when `tab` is already open.
    pub fn open_panel(&mut self, tab: RightPanelTab) {
        if self.right_panel_open && self.right_panel_tab == tab {
            self.right_panel_open = false;
        } else {
            self.right_panel_tab = tab;
            self.right_panel_open = true;
        }
    }

    /// Selects a project and thread in the sidebar and main pane.
    pub fn select_thread(&mut self, project_id: impl Into<String>, thread_id: impl Into<String>) {
        self.selected_project_id = Some(project_id.into());
        self.selected_thread_id = Some(thread_id.into());
    }

    /// Sets `sidebar_width`, clamping to `200.0..=480.0`. Non-finite inputs are ignored.
    pub fn set_sidebar_width(&mut self, width: f32) {
        if width.is_finite() {
            self.sidebar_width = width.clamp(SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
        }
    }

    /// Sets `right_panel_width`, clamping to `320.0..=1200.0`. Non-finite inputs are ignored.
    pub fn set_right_panel_width(&mut self, width: f32) {
        if width.is_finite() {
            self.right_panel_width = width.clamp(RIGHT_PANEL_MIN_WIDTH, RIGHT_PANEL_MAX_WIDTH);
        }
    }

    /// Clamps both `sidebar_width` and `right_panel_width` to their valid ranges.
    pub fn clamp_widths(&mut self) {
        self.sidebar_width = clamp_or_default(
            self.sidebar_width,
            SIDEBAR_MIN_WIDTH,
            SIDEBAR_MAX_WIDTH,
            SIDEBAR_DEFAULT_WIDTH,
        );
        self.right_panel_width = clamp_or_default(
            self.right_panel_width,
            RIGHT_PANEL_MIN_WIDTH,
            RIGHT_PANEL_MAX_WIDTH,
            RIGHT_PANEL_DEFAULT_WIDTH,
        );
    }
}

fn clamp_or_default(value: f32, min: f32, max: f32, default: f32) -> f32 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        default
    }
}
