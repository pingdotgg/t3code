/// Minimum sidebar width in CSS pixels.
pub const SIDEBAR_MIN_WIDTH: f32 = 153.0;
/// Maximum sidebar width in CSS pixels.
pub const SIDEBAR_MAX_WIDTH: f32 = 480.0;
/// Default sidebar width in CSS pixels.
pub const SIDEBAR_DEFAULT_WIDTH: f32 = 233.0;

/// Minimum right-panel width in CSS pixels (Conn `PREVIEW_PANEL_MIN_WIDTH`).
pub const RIGHT_PANEL_MIN_WIDTH: f32 = 360.0;
/// Maximum right-panel width in CSS pixels.
pub const RIGHT_PANEL_MAX_WIDTH: f32 = 1200.0;
/// Default right-panel width in CSS pixels (Conn `PREVIEW_PANEL_DEFAULT_WIDTH`).
pub const RIGHT_PANEL_DEFAULT_WIDTH: f32 = 600.0;

/// Top-level right-panel surfaces matching Conn desktop (`RightPanelTabs.tsx`, `rightPanelStore.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RightPanelTab {
    Files,
    Diff,
    Terminal,
    Browser,
    Api,
    Database,
    Mcp,
    Tasks,
    PullRequest,
    LinkedItems,
    Device,
    /// A file opened from the Files tree (Conn's `file` surface); its path lives in
    /// [`PanelSurface::File`]. Not offered in the add menu.
    File,
}

/// One open right-panel tab: a surface kind, or a file with its project-relative path.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum PanelSurface {
    Kind(RightPanelTab),
    File(String),
}

impl PanelSurface {
    /// The surface kind ([`RightPanelTab::File`] for a file).
    #[must_use]
    pub fn kind(&self) -> RightPanelTab {
        match self {
            Self::Kind(tab) => *tab,
            Self::File(_) => RightPanelTab::File,
        }
    }

    /// The file path of a file surface.
    #[must_use]
    pub fn file_path(&self) -> Option<&str> {
        match self {
            Self::Kind(_) => None,
            Self::File(path) => Some(path),
        }
    }

    /// The tab title for a file: its base name (Conn's `surfaceTitle`).
    #[must_use]
    pub fn file_title(path: &str) -> &str {
        path.rsplit(['/', '\\']).next().unwrap_or(path)
    }
}

impl RightPanelTab {
    /// Surfaces in the order of Conn's add-surface (`+`) menu.
    pub const MENU_ORDER: [Self; 11] = [
        Self::Browser,
        Self::Api,
        Self::Database,
        Self::Mcp,
        Self::Tasks,
        Self::Terminal,
        Self::Files,
        Self::Diff,
        Self::PullRequest,
        Self::LinkedItems,
        Self::Device,
    ];

    /// The surface's single-key shortcut in the add-surface menu.
    #[must_use]
    pub const fn menu_shortcut(self) -> &'static str {
        match self {
            Self::Browser => "B",
            Self::Api => "R",
            Self::Database => "Q",
            Self::Mcp => "I",
            Self::Tasks => "K",
            Self::Terminal => "T",
            Self::Files => "F",
            Self::Diff => "D",
            Self::PullRequest => "P",
            Self::LinkedItems => "L",
            Self::Device => "M",
            Self::File => "",
        }
    }

    /// The surface whose menu shortcut is `key` (case-insensitive).
    #[must_use]
    pub fn from_menu_shortcut(key: &str) -> Option<Self> {
        Self::MENU_ORDER
            .into_iter()
            .find(|tab| tab.menu_shortcut().eq_ignore_ascii_case(key))
    }
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

    /// Whether the open right panel shows the surface launcher (Conn's `Open a surface` list, the
    /// items of the `+` menu) instead of a surface: it is open and has no tab. A panel with tabs
    /// shows its active one, so toggling it back open restores them.
    #[must_use]
    pub fn shows_surface_launcher(&self, open_tab_count: usize) -> bool {
        self.right_panel_open && open_tab_count == 0
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

    /// Sets `right_panel_width`, clamping to `RIGHT_PANEL_MIN_WIDTH..=RIGHT_PANEL_MAX_WIDTH`. Non-finite inputs are ignored.
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

/// What the chat and the right panel need to the right of the thread sidebar
/// (`THREAD_MAIN_CONTENT_MIN_WIDTH`, `threadSidebarWidth.ts`).
pub const MAIN_CONTENT_MIN_WIDTH: f32 = 640.0;
/// The chat column's least width beside an open right panel (`SIBLING_COLUMN_MIN_WIDTH`).
pub const CHAT_BESIDE_PANEL_MIN_WIDTH: f32 = 360.0;
/// The right panel's widest share of the window (`PREVIEW_PANEL_MAX_WIDTH_FRACTION`).
const RIGHT_PANEL_MAX_WINDOW_FRACTION: f32 = 0.7;

/// How wide the thread sidebar may be in a window `viewport_w` wide with the rail `rail_w` wide:
/// the rest must keep `MAIN_CONTENT_MIN_WIDTH` (`resolveThreadSidebarMaximumWidth`). The right
/// panel does not count: it is part of that rest and gives way (`shouldAcceptWidth`).
#[must_use]
pub fn sidebar_max_width(viewport_w: f32, rail_w: f32) -> f32 {
    (viewport_w - rail_w - MAIN_CONTENT_MIN_WIDTH).clamp(SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH)
}

/// How wide the right panel may be with `left_w` of rail and sidebar beside it
/// (`getPreviewPanelMaxWidth`): at most 70% of the window and leaving the chat
/// `CHAT_BESIDE_PANEL_MIN_WIDTH`, never under its own minimum.
#[must_use]
pub fn right_panel_max_width(viewport_w: f32, left_w: f32) -> f32 {
    let by_fraction = (viewport_w * RIGHT_PANEL_MAX_WINDOW_FRACTION).floor();
    let by_chat = (viewport_w - left_w).floor() - CHAT_BESIDE_PANEL_MIN_WIDTH;
    by_fraction
        .min(by_chat)
        .clamp(RIGHT_PANEL_MIN_WIDTH, RIGHT_PANEL_MAX_WIDTH)
}

impl LayoutState {
    /// A sidebar seam drag: the width `wanted` by the pointer, held between the minimum and
    /// what the window allows. `rail_w` is the workspace rail beside the sidebar.
    pub fn drag_sidebar_width(&mut self, wanted: f32, viewport_w: f32, rail_w: f32) {
        if wanted.is_finite() {
            let max = sidebar_max_width(viewport_w, rail_w);
            self.sidebar_width = wanted.clamp(SIDEBAR_MIN_WIDTH, max);
        }
    }

    /// A right-panel seam drag: the width `wanted` by the pointer, held between the minimum and
    /// what the window and the sidebar leave.
    pub fn drag_right_panel_width(&mut self, wanted: f32, viewport_w: f32, rail_w: f32) {
        if wanted.is_finite() {
            // The rail goes with the sidebar when it is closed.
            let left = if self.sidebar_open {
                rail_w + self.sidebar_width
            } else {
                0.0
            };
            let max = right_panel_max_width(viewport_w, left);
            self.right_panel_width = wanted.clamp(RIGHT_PANEL_MIN_WIDTH, max);
        }
    }
}

fn clamp_or_default(value: f32, min: f32, max: f32, default: f32) -> f32 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        default
    }
}

#[cfg(test)]
mod surface_tests {
    use super::*;

    #[test]
    fn file_surfaces_title_by_base_name() {
        assert_eq!(
            PanelSurface::file_title("crates/conn-app/src/main.rs"),
            "main.rs"
        );
        assert_eq!(PanelSurface::file_title("Cargo.toml"), "Cargo.toml");
        let surface = PanelSurface::File("docs/status.md".into());
        assert_eq!(surface.kind(), RightPanelTab::File);
        assert_eq!(surface.file_path(), Some("docs/status.md"));
        assert_eq!(PanelSurface::Kind(RightPanelTab::Api).file_path(), None);
    }

    #[test]
    fn opening_the_right_panel_with_no_tabs_shows_the_launcher() {
        let mut layout = LayoutState::default();
        // Closed: nothing shows, tabs or not.
        assert!(!layout.shows_surface_launcher(0));
        assert!(!layout.shows_surface_launcher(2));
        layout.toggle_right_panel();
        // Open with no tab: the launcher, never Files by default.
        assert!(layout.shows_surface_launcher(0));
        // Open with tabs: the active tab shows.
        assert!(!layout.shows_surface_launcher(1));
        // Closing and reopening a panel that has tabs restores them, with no launcher.
        layout.toggle_right_panel();
        layout.toggle_right_panel();
        assert!(!layout.shows_surface_launcher(3));
    }

    #[test]
    fn file_is_not_in_the_add_menu() {
        assert!(!RightPanelTab::MENU_ORDER.contains(&RightPanelTab::File));
        assert_eq!(RightPanelTab::from_menu_shortcut(""), None);
    }
}

#[cfg(test)]
mod width_tests {
    use super::*;

    const RAIL: f32 = 54.0;

    #[test]
    fn the_sidebar_may_grow_until_the_rest_has_640() {
        assert_eq!(sidebar_max_width(1440.0, RAIL), SIDEBAR_MAX_WIDTH);
        // 1000 - 54 - 640 = 306.
        assert_eq!(sidebar_max_width(1000.0, RAIL), 306.0);
        // A window too narrow for it leaves the minimum, not less.
        assert_eq!(sidebar_max_width(700.0, RAIL), SIDEBAR_MIN_WIDTH);
    }

    #[test]
    fn an_open_right_panel_does_not_stop_the_sidebar_growing() {
        let mut layout = LayoutState {
            right_panel_open: true,
            right_panel_width: 600.0,
            sidebar_width: 233.0,
            ..LayoutState::default()
        };
        layout.drag_sidebar_width(300.0, 1440.0, RAIL);
        assert_eq!(layout.sidebar_width, 300.0);
        layout.drag_sidebar_width(900.0, 1440.0, RAIL);
        assert_eq!(layout.sidebar_width, SIDEBAR_MAX_WIDTH);
        layout.drag_sidebar_width(10.0, 1440.0, RAIL);
        assert_eq!(layout.sidebar_width, SIDEBAR_MIN_WIDTH);
        layout.drag_sidebar_width(f32::NAN, 1440.0, RAIL);
        assert_eq!(
            layout.sidebar_width, SIDEBAR_MIN_WIDTH,
            "a bad value changes nothing"
        );
    }

    #[test]
    fn the_right_panel_may_grow_until_the_chat_has_360_or_it_takes_70_percent() {
        // 1440 - 287 - 360 = 793, under 70% of 1440 (1008).
        assert_eq!(right_panel_max_width(1440.0, 287.0), 793.0);
        // A wide window: the 70% cap binds.
        assert_eq!(right_panel_max_width(1600.0, 100.0), 1120.0);
        // No room: the panel keeps its minimum.
        assert_eq!(right_panel_max_width(700.0, 287.0), RIGHT_PANEL_MIN_WIDTH);
        assert!(right_panel_max_width(4000.0, 100.0) <= RIGHT_PANEL_MAX_WIDTH);
    }

    #[test]
    fn dragging_the_right_panel_wider_never_snaps_it_narrower() {
        let mut layout = LayoutState {
            sidebar_width: 233.0,
            right_panel_width: 600.0,
            ..LayoutState::default()
        };
        layout.drag_right_panel_width(680.0, 1440.0, RAIL);
        assert_eq!(layout.right_panel_width, 680.0);
        layout.drag_right_panel_width(2000.0, 1440.0, RAIL);
        assert_eq!(layout.right_panel_width, 793.0);
        layout.drag_right_panel_width(100.0, 1440.0, RAIL);
        assert_eq!(layout.right_panel_width, RIGHT_PANEL_MIN_WIDTH);
    }

    #[test]
    fn a_closed_sidebar_leaves_the_panel_the_whole_window() {
        let mut layout = LayoutState {
            sidebar_open: false,
            ..LayoutState::default()
        };
        layout.drag_right_panel_width(2000.0, 1440.0, RAIL);
        assert_eq!(layout.right_panel_width, 1008.0);
    }
}
