//! Right-panel surfaces for `conn-app`: Conn tab header, Files explorer + source preview,
//! Diff viewer, local PTY Terminal, and Browser surface.

mod api;
mod browser;
pub(crate) mod chrome;
mod color;
mod diff;
mod diff_parser;
mod files;
pub(crate) mod header;
mod highlight;
mod terminal;
mod terminal_palette;
mod tree;

use std::fmt;
use std::rc::Rc;

use conn_client::Connection;
use conn_state::RightPanelTab;
use conn_theme::Tokens;
use gpui_kit::component::v_flex;
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, App, Context, Entity, IntoElement, ParentElement, Render, Styled, Window, div, px,
};

use self::api::ApiPanel;
use self::browser::BrowserPanel;
use self::color::to_hsla;
use self::diff::DiffPanel;
use self::files::FilesPanel;
use self::header::{
    PanelHeaderCallbacks, PanelHeaderProps, panel_tab_icon_path, panel_tab_label,
    render_panel_header, superhero_icon,
};
use self::terminal::TerminalPanel;

const UI_TEXT_PX: f32 = 13.0;
const UI_LINE_HEIGHT_PX: f32 = 20.0;

/// Right-panel GPUI entity mounted inside Conn's right-panel card.
#[expect(
    unreachable_pub,
    reason = "binary crate module; public API for orchestrator wiring"
)]
pub struct RightPanel {
    tokens: Tokens,
    tab: RightPanelTab,
    open_tabs: Vec<RightPanelTab>,
    add_menu_open: bool,
    maximized: bool,
    bottom_dock_open: bool,
    project_id: Option<String>,
    workspace_root: Option<String>,
    thread_id: Option<String>,
    files: Entity<FilesPanel>,
    diff: Entity<DiffPanel>,
    terminal: Entity<TerminalPanel>,
    browser: Entity<BrowserPanel>,
    api: Entity<ApiPanel>,
    /// True while the right panel is open and nothing covers it (see `set_surface_visible`).
    surface_visible: bool,
    /// False when the shell draws the tab strip in its 44px glass header and the card fill.
    chrome: bool,
}

impl fmt::Debug for RightPanel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RightPanel")
            .field("tab", &self.tab)
            .field("open_tabs", &self.open_tabs)
            .field("project_id", &self.project_id)
            .field("workspace_root", &self.workspace_root)
            .field("thread_id", &self.thread_id)
            .finish_non_exhaustive()
    }
}

#[expect(dead_code, reason = "wired into the shell by the orchestrator")]
#[expect(
    unreachable_pub,
    reason = "binary crate module; public API for orchestrator wiring"
)]
impl RightPanel {
    /// Creates a new [`RightPanel`] entity with the active theme [`Tokens`] and optional
    /// [`Connection`] to `conn-server`.
    pub fn new(
        tokens: Tokens,
        connection: Option<Connection>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Self {
        let files = cx.new(|cx| FilesPanel::new(tokens.clone(), connection.clone(), window, cx));
        let diff = cx.new(|_| DiffPanel::new(tokens.clone(), connection));
        let terminal = cx.new(|cx| TerminalPanel::new(tokens.clone(), cx));
        let browser = cx.new(|cx| BrowserPanel::new(tokens.clone(), window, cx));
        let api = cx.new(|cx| ApiPanel::new(tokens.clone(), window, cx));

        Self {
            tokens,
            tab: RightPanelTab::Files,
            open_tabs: vec![RightPanelTab::Files],
            add_menu_open: false,
            maximized: false,
            bottom_dock_open: false,
            project_id: None,
            workspace_root: None,
            thread_id: None,
            files,
            diff,
            terminal,
            browser,
            api,
            chrome: true,
            surface_visible: false,
        }
    }

    /// Renders only the active surface; the shell owns the tab strip and the card.
    pub fn set_embedded(&mut self, embedded: bool, cx: &mut Context<'_, Self>) {
        self.chrome = !embedded;
        cx.notify();
    }

    /// Loads `url` in the Browser tab (starting the CEF runtime on first use).
    #[cfg_attr(
        not(feature = "automation"),
        expect(dead_code, reason = "driven by the automation hook")
    )]
    pub fn navigate_browser(&mut self, url: String, cx: &mut Context<'_, Self>) {
        self.browser.update(cx, |b, cx| b.navigate(url, cx));
    }

    /// Diagnostic state of the Browser tab.
    #[cfg(feature = "automation")]
    pub fn browser_state(&self, cx: &App) -> serde_json::Value {
        self.browser.read(cx).automation_state()
    }

    /// The Browser tab's page title (empty before a page loads).
    #[cfg_attr(
        not(feature = "automation"),
        expect(dead_code, reason = "driven by the automation hook")
    )]
    pub fn browser_title(&self, cx: &App) -> String {
        self.browser.read(cx).title()
    }

    /// Updates theme tokens across the tab strip and every right-panel surface.
    pub fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens.clone();
        self.files
            .update(cx, |p, cx| p.set_tokens(tokens.clone(), cx));
        self.diff
            .update(cx, |p, cx| p.set_tokens(tokens.clone(), cx));
        self.terminal
            .update(cx, |p, cx| p.set_tokens(tokens.clone(), cx));
        self.api
            .update(cx, |p, cx| p.set_tokens(tokens.clone(), cx));
        self.browser.update(cx, |p, cx| p.set_tokens(tokens, cx));
        cx.notify();
    }

    /// Updates the active project, workspace root, and thread context.
    pub fn set_context(
        &mut self,
        project_id: Option<String>,
        workspace_root: Option<String>,
        thread_id: Option<String>,
        cx: &mut Context<'_, Self>,
    ) {
        if self.project_id != project_id {
            let key = project_id.clone();
            self.api.update(cx, |p, cx| p.set_project(key, cx));
        }
        self.project_id = project_id;
        if self.workspace_root != workspace_root {
            self.workspace_root = workspace_root.clone();
            self.files
                .update(cx, |p, cx| p.set_workspace_root(workspace_root.clone(), cx));
            self.terminal
                .update(cx, |p, cx| p.set_workspace_root(workspace_root, cx));
        }
        if self.thread_id != thread_id {
            self.thread_id = thread_id.clone();
            self.diff.update(cx, |p, cx| p.set_thread(thread_id, cx));
        }
        cx.notify();
    }

    /// Optional hint for the active thread's completed turn count used by `orchestration.getFullThreadDiff`.
    pub fn set_turn_count(&mut self, turn_count: Option<i64>, cx: &mut Context<'_, Self>) {
        self.diff
            .update(cx, |p, cx| p.set_turn_count(turn_count, cx));
    }

    /// Whether the native browser view may show: the shell passes `true` only when the right
    /// panel is open and no GPUI overlay covers it. The Browser tab must also be active.
    pub fn set_surface_visible(&mut self, visible: bool, cx: &mut Context<'_, Self>) {
        self.surface_visible = visible;
        self.sync_browser_visibility(cx);
    }

    fn sync_browser_visibility(&mut self, cx: &mut Context<'_, Self>) {
        let show = self.surface_visible && self.tab == RightPanelTab::Browser;
        self.browser.update(cx, |b, cx| b.set_visible(show, cx));
    }

    /// Switches the active right-panel tab (opening it if not yet in `open_tabs`),
    /// lazily spawning the terminal PTY on first visit.
    pub fn set_tab(&mut self, tab: RightPanelTab, cx: &mut Context<'_, Self>) {
        if !self.open_tabs.contains(&tab) {
            self.open_tabs.push(tab);
        }
        self.add_menu_open = false;
        if self.tab == tab {
            cx.notify();
            return;
        }
        self.tab = tab;
        self.sync_browser_visibility(cx);
        if tab == RightPanelTab::Terminal {
            self.terminal.update(cx, |p, cx| p.ensure_started(cx));
        }
        cx.notify();
    }

    /// Closes an open tab if more than one tab is open, activating an adjacent tab if needed.
    pub fn close_tab(&mut self, tab: RightPanelTab, cx: &mut Context<'_, Self>) {
        if self.open_tabs.len() <= 1 {
            return;
        }
        if let Some(pos) = self.open_tabs.iter().position(|&t| t == tab) {
            self.open_tabs.remove(pos);
            if self.tab == tab {
                let next = self
                    .open_tabs
                    .get(pos.saturating_sub(1))
                    .copied()
                    .unwrap_or(RightPanelTab::Files);
                self.tab = next;
                self.sync_browser_visibility(cx);
            }
            cx.notify();
        }
    }

    /// Returns the currently active right-panel tab.
    #[must_use]
    pub fn tab(&self) -> RightPanelTab {
        self.tab
    }

    /// Returns the list of currently open right-panel tabs.
    #[must_use]
    pub fn open_tabs(&self) -> &[RightPanelTab] {
        &self.open_tabs
    }

    /// Renders the 44px header tab strip (`RightPanelTabs`), suitable for mounting either
    /// inside [`RightPanel::render`] or directly in the shell's glass header row.
    pub fn render_tabs(&self, cx: &mut Context<'_, Self>) -> AnyElement {
        let entity = cx.entity();
        let callbacks = PanelHeaderCallbacks {
            on_select_tab: {
                let entity = entity.clone();
                Rc::new(move |tab, _, cx| {
                    entity.update(cx, |this, cx| this.set_tab(tab, cx));
                })
            },
            on_close_tab: Some({
                let entity = entity.clone();
                Rc::new(move |tab, _, cx| {
                    entity.update(cx, |this, cx| this.close_tab(tab, cx));
                })
            }),
            on_toggle_add_menu: {
                let entity = entity.clone();
                Rc::new(move |_, cx| {
                    entity.update(cx, |this, cx| {
                        this.add_menu_open = !this.add_menu_open;
                        cx.notify();
                    });
                })
            },
            on_add_tab: {
                let entity = entity.clone();
                Rc::new(move |tab, _, cx| {
                    entity.update(cx, |this, cx| this.set_tab(tab, cx));
                })
            },
            on_toggle_maximize: {
                let entity = entity.clone();
                Rc::new(move |_, cx| {
                    entity.update(cx, |this, cx| {
                        this.maximized = !this.maximized;
                        cx.notify();
                    });
                })
            },
            on_toggle_dock_bottom: {
                let entity = entity.clone();
                Rc::new(move |_, cx| {
                    entity.update(cx, |this, cx| {
                        this.bottom_dock_open = !this.bottom_dock_open;
                        cx.notify();
                    });
                })
            },
            on_toggle_panel: Rc::new(move |_, cx| {
                entity.update(cx, |this, cx| {
                    this.add_menu_open = false;
                    cx.notify();
                });
            }),
        };

        render_panel_header(
            PanelHeaderProps {
                open_tabs: &self.open_tabs,
                active_tab: self.tab,
                maximized: self.maximized,
                bottom_dock_open: self.bottom_dock_open,
                panel_open: true,
                add_menu_open: self.add_menu_open,
                available_tabs: &RightPanelTab::MENU_ORDER,
                tokens: &self.tokens,
            },
            callbacks,
        )
        .into_any_element()
    }
}

impl Render for RightPanel {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        if self.tab == RightPanelTab::Terminal {
            self.terminal.update(cx, |p, cx| p.ensure_started(cx));
        }

        let card_bg = to_hsla(self.tokens.shell_card);
        let divider = to_hsla(self.tokens.shell_divider);
        let muted = to_hsla(self.tokens.muted_foreground);

        let body: AnyElement = match self.tab {
            RightPanelTab::Files => self.files.clone().into_any_element(),
            RightPanelTab::Diff => self.diff.clone().into_any_element(),
            RightPanelTab::Terminal => self.terminal.clone().into_any_element(),
            RightPanelTab::Browser => self.browser.clone().into_any_element(),
            RightPanelTab::Api => self.api.clone().into_any_element(),
            other => placeholder_surface(
                panel_tab_label(other),
                panel_tab_icon_path(other),
                &self.tokens,
                muted,
            ),
        };

        if !self.chrome {
            return v_flex()
                .size_full()
                .child(div().flex_1().min_h_0().w_full().child(body));
        }
        v_flex()
            .size_full()
            .bg(card_bg)
            .child(self.render_tabs(cx))
            .child(div().w_full().h(px(1.0)).bg(divider))
            .child(div().flex_1().min_h_0().w_full().child(body))
    }
}

fn placeholder_surface(
    title: &str,
    icon_path: &'static str,
    tokens: &Tokens,
    muted: gpui_kit::Hsla,
) -> AnyElement {
    v_flex()
        .size_full()
        .items_center()
        .justify_center()
        .gap(px(10.0))
        .child(
            div()
                .size(px(40.0))
                .rounded(px(10.0))
                .bg(to_hsla(tokens.shell_tile))
                .border_1()
                .border_color(to_hsla(tokens.shell_tile_border))
                .flex()
                .items_center()
                .justify_center()
                .child(superhero_icon(icon_path, 18.0, to_hsla(tokens.foreground))),
        )
        .child(
            div()
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(muted)
                .child(format!("{title} is not yet connected.")),
        )
        .into_any_element()
}
