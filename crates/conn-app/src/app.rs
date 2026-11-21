//! Root [`ConnApp`] GPUI view holding shell state, layout state, and theme tokens.

use std::collections::HashSet;

use conn_state::{LayoutState, RightPanelTab, ShellState, ThreadActivity};
use conn_theme::{ShellGeometry, Tokens};
use gpui_kit::{
    App, Context, FocusHandle, Focusable, InteractiveElement as _, IntoElement, KeyBinding,
    ParentElement as _, Render, StatefulInteractiveElement as _, Styled as _, Window,
    WindowControlArea, actions, div, px,
};

use crate::fixture::{demo_shell_state, thread_activity};
use crate::header::render_chat_header;
use crate::icons;
use crate::shell::{CardJoin, inset_card, two_tone_divider};
use crate::sidebar::rail::render_workspace_rail;
use crate::sidebar::thread_list::render_thread_sidebar;
use crate::theme::{apply_kit_theme, hsla};

actions!(conn_app, [ToggleSidebar, ToggleRightPanel]);

const ALL_RIGHT_PANEL_TABS: [RightPanelTab; 7] = [
    RightPanelTab::Files,
    RightPanelTab::Diff,
    RightPanelTab::Terminal,
    RightPanelTab::Browser,
    RightPanelTab::Database,
    RightPanelTab::Mcp,
    RightPanelTab::Device,
];

/// Registers global shell keyboard shortcuts (`Cmd+B` and `Cmd+Alt+B`).
pub(crate) fn register_keybindings(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-b", ToggleSidebar, None),
        KeyBinding::new("cmd-alt-b", ToggleRightPanel, None),
    ]);
}

/// Root view of the Conn native desktop shell.
pub(crate) struct ConnApp {
    tokens: Tokens,
    geometry: ShellGeometry,
    shell: ShellState,
    layout: LayoutState,
    active_workspace: Option<String>,
    collapsed_projects: HashSet<String>,
    focus_handle: FocusHandle,
}

impl std::fmt::Debug for ConnApp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnApp")
            .field("layout", &self.layout)
            .field("active_workspace", &self.active_workspace)
            .field("projects", &self.shell.projects.len())
            .field("threads", &self.shell.threads.len())
            .finish()
    }
}

impl ConnApp {
    /// Creates the root shell initialized with [`Tokens::placeholder_dark`] and
    /// the built-in demo fixture.
    #[must_use]
    pub(crate) fn new(_window: &mut Window, cx: &mut Context<'_, Self>) -> Self {
        let tokens = Tokens::placeholder_dark();
        let shell = demo_shell_state();
        let mut layout = LayoutState::default();
        if let Some(first_thread) = shell.threads.first() {
            layout.selected_project_id = Some(first_thread.project_id.clone());
            layout.selected_thread_id = Some(first_thread.id.clone());
        }

        Self {
            tokens,
            geometry: ShellGeometry::default(),
            shell,
            layout,
            active_workspace: None,
            collapsed_projects: HashSet::new(),
            focus_handle: cx.focus_handle(),
        }
    }

    /// Selects a thread by id, updating [`LayoutState`] and triggering a repaint.
    pub(crate) fn select_thread(
        &mut self,
        thread_id: impl Into<String>,
        cx: &mut Context<'_, Self>,
    ) {
        let thread_id = thread_id.into();
        let project_id = self.shell.thread(&thread_id).map(|t| t.project_id.clone());
        self.layout.selected_thread_id = Some(thread_id);
        if project_id.is_some() {
            self.layout.selected_project_id = project_id;
        }
        cx.notify();
    }

    /// Toggles the left workspace rail + thread sidebar (`Cmd+B`).
    pub(crate) fn toggle_sidebar(&mut self, cx: &mut Context<'_, Self>) {
        self.layout.sidebar_open = !self.layout.sidebar_open;
        cx.notify();
    }

    /// Toggles the right panel slot (`Cmd+Alt+B`).
    pub(crate) fn toggle_right_panel(&mut self, cx: &mut Context<'_, Self>) {
        self.layout.right_panel_open = !self.layout.right_panel_open;
        cx.notify();
    }

    /// Selects a right-panel tab and opens the right panel if it was closed.
    pub(crate) fn select_right_panel_tab(
        &mut self,
        tab: RightPanelTab,
        cx: &mut Context<'_, Self>,
    ) {
        self.layout.right_panel_tab = tab;
        self.layout.right_panel_open = true;
        cx.notify();
    }

    /// Toggles the right panel when clicking the already-active tab toggle, or
    /// opens and switches to `tab` otherwise.
    pub(crate) fn activate_or_toggle_right_panel_tab(
        &mut self,
        tab: RightPanelTab,
        cx: &mut Context<'_, Self>,
    ) {
        if self.layout.right_panel_open && self.layout.right_panel_tab == tab {
            self.layout.right_panel_open = false;
        } else {
            self.layout.right_panel_tab = tab;
            self.layout.right_panel_open = true;
        }
        cx.notify();
    }

    /// Replaces the active theme tokens and updates `gpui-kit`'s global theme.
    #[expect(
        dead_code,
        reason = "programmatic state hook for theme switching and future automation"
    )]
    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        apply_kit_theme(&tokens, cx);
        self.tokens = tokens;
        cx.notify();
    }

    /// Replaces the shell snapshot (projects and threads).
    #[expect(
        dead_code,
        reason = "programmatic state hook for conn-client snapshots and future automation"
    )]
    pub(crate) fn set_shell(&mut self, shell: ShellState, cx: &mut Context<'_, Self>) {
        self.shell = shell;
        cx.notify();
    }

    /// Scopes the thread sidebar to one workspace (`Some(project_id)`) or all
    /// projects (`None`).
    pub(crate) fn select_workspace(
        &mut self,
        workspace_id: Option<String>,
        cx: &mut Context<'_, Self>,
    ) {
        self.active_workspace = workspace_id;
        cx.notify();
    }

    /// Toggles a project group's collapsed state in the thread sidebar.
    pub(crate) fn toggle_project_collapsed(
        &mut self,
        project_id: &str,
        cx: &mut Context<'_, Self>,
    ) {
        if !self.collapsed_projects.remove(project_id) {
            self.collapsed_projects.insert(project_id.to_owned());
        }
        cx.notify();
    }

    /// Current layout state.
    #[expect(
        dead_code,
        reason = "programmatic state reader for future automation and tests"
    )]
    #[must_use]
    pub(crate) fn layout(&self) -> &LayoutState {
        &self.layout
    }

    /// Current shell state.
    #[expect(
        dead_code,
        reason = "programmatic state reader for future automation and tests"
    )]
    #[must_use]
    pub(crate) fn shell(&self) -> &ShellState {
        &self.shell
    }

    /// Active theme tokens.
    #[expect(
        dead_code,
        reason = "programmatic state reader for future automation and tests"
    )]
    #[must_use]
    pub(crate) fn tokens(&self) -> &Tokens {
        &self.tokens
    }

    fn render_chat_column(&self, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let header =
            render_chat_header(&self.shell, &self.layout, &self.tokens, &self.geometry, cx);

        let join = CardJoin {
            left: self.layout.sidebar_open,
            right: self.layout.right_panel_open,
        };

        let active_thread = self
            .layout
            .selected_thread_id
            .as_deref()
            .and_then(|id| self.shell.thread(id));

        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground);

        let body = if let Some(thread) = active_thread {
            let activity_label = match thread_activity(&self.shell, thread) {
                ThreadActivity::Working => "Working",
                ThreadActivity::NeedsAttention => "Needs attention",
                ThreadActivity::Failed => "Failed",
                ThreadActivity::Idle => "Idle",
            };

            div()
                .flex()
                .flex_col()
                .flex_1()
                .items_center()
                .justify_center()
                .gap(px(12.0))
                .px(px(24.0))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_center()
                        .size(px(44.0))
                        .rounded(px(12.0))
                        .bg(hsla(self.tokens.shell_tile))
                        .border_1()
                        .border_color(hsla(self.tokens.shell_tile_border))
                        .child(icons::chrome(
                            gpui_kit::assets::IconName::MessageSquare,
                            muted,
                        )),
                )
                .child(
                    div()
                        .text_size(px(14.0))
                        .font_weight(gpui_kit::FontWeight::MEDIUM)
                        .text_color(fg)
                        .child(thread.title.clone()),
                )
                .child(
                    div()
                        .text_size(px(self.geometry.ui_font_size_px))
                        .line_height(px(self.geometry.ui_line_height_px))
                        .text_color(muted)
                        .child(format!(
                            "Status: {activity_label} · Chat timeline lands in Phase 3"
                        )),
                )
        } else {
            div()
                .flex()
                .flex_1()
                .items_center()
                .justify_center()
                .text_size(px(self.geometry.ui_font_size_px))
                .line_height(px(self.geometry.ui_line_height_px))
                .text_color(muted)
                .child("Select a thread from the sidebar")
        };

        let chat_card = inset_card(&self.tokens, &self.geometry, join).child(body);

        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .h_full()
            .child(header)
            .child(chat_card)
    }

    fn render_right_panel_column(&self, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground);
        let highlight = hsla(self.tokens.shell_highlight);

        let mut tab_items = Vec::with_capacity(ALL_RIGHT_PANEL_TABS.len());
        for (idx, tab) in ALL_RIGHT_PANEL_TABS.into_iter().enumerate() {
            let active = self.layout.right_panel_tab == tab;
            let text_color = if active { fg } else { muted };
            let mut item = div()
                .id(("right-panel-tab", idx))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.0))
                .h(px(28.0))
                .px(px(8.0))
                .rounded(px(6.0))
                .cursor_pointer()
                .text_size(px(14.0))
                .text_color(text_color)
                .hover(move |s| s.bg(highlight))
                .on_click(cx.listener(move |app, _event, _window, cx| {
                    app.select_right_panel_tab(tab, cx);
                }))
                .child(icons::chrome(icons::right_panel_tab_icon(tab), text_color))
                .child(right_panel_tab_label(tab));

            if active {
                item = item.bg(highlight).font_weight(gpui_kit::FontWeight::MEDIUM);
            }

            tab_items.push(item);
        }

        let header = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(4.0))
            .w_full()
            .h(px(self.geometry.header_height_px))
            .flex_shrink_0()
            .px(px(12.0))
            .overflow_hidden()
            .window_control_area(WindowControlArea::Drag)
            .children(tab_items);

        let active_label = right_panel_tab_label(self.layout.right_panel_tab);
        let card = inset_card(
            &self.tokens,
            &self.geometry,
            CardJoin {
                left: true,
                right: false,
            },
        )
        .items_center()
        .justify_center()
        .gap(px(12.0))
        .child(
            div()
                .flex()
                .items_center()
                .justify_center()
                .size(px(44.0))
                .rounded(px(12.0))
                .bg(hsla(self.tokens.shell_tile))
                .border_1()
                .border_color(hsla(self.tokens.shell_tile_border))
                .child(icons::chrome(
                    icons::right_panel_tab_icon(self.layout.right_panel_tab),
                    muted,
                )),
        )
        .child(
            div()
                .text_size(px(self.geometry.ui_font_size_px))
                .line_height(px(self.geometry.ui_line_height_px))
                .text_color(muted)
                .child(format!("{active_label} panel")),
        );

        div()
            .flex()
            .flex_col()
            .w(px(self.layout.right_panel_width))
            .h_full()
            .flex_shrink_0()
            .child(header)
            .child(card)
    }
}

impl Focusable for ConnApp {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for ConnApp {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let mut root = div()
            .id("conn-shell-root")
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(|app, _: &ToggleSidebar, _window, cx| {
                app.toggle_sidebar(cx);
            }))
            .on_action(cx.listener(|app, _: &ToggleRightPanel, _window, cx| {
                app.toggle_right_panel(cx);
            }))
            .flex()
            .flex_row()
            .size_full()
            .overflow_hidden()
            .bg(hsla(self.tokens.shell_fill))
            .font_family(".SystemUIFont")
            .text_size(px(self.geometry.ui_font_size_px))
            .line_height(px(self.geometry.ui_line_height_px))
            .text_color(hsla(self.tokens.foreground));

        if self.layout.sidebar_open {
            root = root
                .child(render_workspace_rail(
                    &self.shell,
                    self.active_workspace.as_deref(),
                    &self.tokens,
                    &self.geometry,
                    cx,
                ))
                .child(render_thread_sidebar(
                    &self.shell,
                    &self.layout,
                    self.active_workspace.as_deref(),
                    &self.collapsed_projects,
                    &self.tokens,
                    &self.geometry,
                    cx,
                ))
                .child(two_tone_divider(&self.tokens, &self.geometry));
        }

        root = root.child(self.render_chat_column(cx));

        if self.layout.right_panel_open {
            root = root
                .child(two_tone_divider(&self.tokens, &self.geometry))
                .child(self.render_right_panel_column(cx));
        }

        root
    }
}

fn right_panel_tab_label(tab: RightPanelTab) -> &'static str {
    match tab {
        RightPanelTab::Files => "Files",
        RightPanelTab::Diff => "Diff",
        RightPanelTab::Terminal => "Terminal",
        RightPanelTab::Browser => "Browser",
        RightPanelTab::Database => "Database",
        RightPanelTab::Mcp => "MCP",
        RightPanelTab::Device => "Device",
    }
}
