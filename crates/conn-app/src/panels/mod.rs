//! Right-panel surfaces for `conn-app`: tab strip, Files explorer + source preview,
//! Diff viewer, local PTY Terminal, and Browser placeholder.

mod browser;
mod color;
mod diff;
mod diff_parser;
mod files;
mod highlight;
mod terminal;
mod terminal_palette;
mod tree;

use std::fmt;

use conn_client::Connection;
use conn_state::RightPanelTab;
use conn_theme::Tokens;
use gpui_kit::assets::IconName;
use gpui_kit::component::{Icon, h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, Context, Entity, InteractiveElement, IntoElement, MouseButton, ParentElement,
    Render, SharedString, Styled, Window, div, px,
};

use self::browser::BrowserPanel;
use self::color::to_hsla;
use self::diff::DiffPanel;
use self::files::FilesPanel;
use self::terminal::TerminalPanel;

const HEADER_HEIGHT_PX: f32 = 44.0;
const TAB_HEIGHT_PX: f32 = 28.0;
const TAB_FONT_SIZE_PX: f32 = 14.0;
const TAB_ICON_SIZE_PX: f32 = 16.0;
#[expect(
    dead_code,
    reason = "used by placeholder_surface once RightPanel is mounted"
)]
const UI_TEXT_PX: f32 = 13.0;
#[expect(
    dead_code,
    reason = "used by placeholder_surface once RightPanel is mounted"
)]
const UI_LINE_HEIGHT_PX: f32 = 20.0;

const PRIMARY_TABS: [(RightPanelTab, &str, IconName); 4] = [
    (RightPanelTab::Files, "Files", IconName::Folder),
    (RightPanelTab::Diff, "Diff", IconName::FileDiff),
    (
        RightPanelTab::Terminal,
        "Terminal",
        IconName::SquareTerminal,
    ),
    (RightPanelTab::Browser, "Browser", IconName::Globe),
];

/// Right-panel GPUI entity mounted inside Conn's right-panel card.
#[expect(dead_code, reason = "wired into the shell by the orchestrator")]
#[expect(
    unreachable_pub,
    reason = "binary crate module; public API for orchestrator wiring"
)]
pub struct RightPanel {
    tokens: Tokens,
    tab: RightPanelTab,
    project_id: Option<String>,
    workspace_root: Option<String>,
    thread_id: Option<String>,
    files: Entity<FilesPanel>,
    diff: Entity<DiffPanel>,
    terminal: Entity<TerminalPanel>,
    browser: Entity<BrowserPanel>,
}

impl fmt::Debug for RightPanel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RightPanel")
            .field("tab", &self.tab)
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

        Self {
            tokens,
            tab: RightPanelTab::Files,
            project_id: None,
            workspace_root: None,
            thread_id: None,
            files,
            diff,
            terminal,
            browser,
        }
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

    /// Switches the active right-panel tab, lazily spawning the terminal PTY on first visit.
    pub fn set_tab(&mut self, tab: RightPanelTab, cx: &mut Context<'_, Self>) {
        self.tab = tab;
        if tab == RightPanelTab::Terminal {
            self.terminal.update(cx, |p, cx| p.ensure_started(cx));
        }
        cx.notify();
    }

    /// Returns the currently active right-panel tab.
    #[must_use]
    pub fn tab(&self) -> RightPanelTab {
        self.tab
    }

    /// Renders the 44px header tab strip (`RightPanelTabs`), suitable for mounting either
    /// inside [`RightPanel::render`] or directly in the shell's glass header row.
    pub fn render_tabs(&self, cx: &mut Context<'_, Self>) -> AnyElement {
        let fg = to_hsla(self.tokens.foreground);
        let muted = to_hsla(self.tokens.muted_foreground);
        let highlight = to_hsla(self.tokens.shell_highlight);

        let mut strip = h_flex()
            .w_full()
            .h(px(HEADER_HEIGHT_PX))
            .pl(px(16.0))
            .pr(px(12.0))
            .items_center()
            .gap(px(4.0));

        for (tab_kind, label, icon) in PRIMARY_TABS {
            let active = self.tab == tab_kind;
            let text_color = if active { fg } else { muted };
            let btn = h_flex()
                .id(SharedString::from(format!("right-tab-{label}")))
                .h(px(TAB_HEIGHT_PX))
                .px(px(8.0))
                .gap(px(6.0))
                .items_center()
                .rounded(px(8.0))
                .cursor_pointer()
                .text_size(px(TAB_FONT_SIZE_PX))
                .text_color(text_color)
                .when(active, |el| el.bg(highlight))
                .when(!active, |el| {
                    el.hover(move |s| s.bg(highlight).text_color(fg))
                })
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |this, _, _, cx| this.set_tab(tab_kind, cx)),
                )
                .child(
                    Icon::new(icon)
                        .size(px(TAB_ICON_SIZE_PX))
                        .text_color(text_color),
                )
                .child(label);
            strip = strip.child(btn);
        }

        // Trailing "+" button matching Conn's RightPanelTabs launcher trigger.
        let next_tab = next_primary_tab(self.tab);
        strip = strip.child(
            div()
                .id("right-tab-add")
                .size(px(TAB_HEIGHT_PX))
                .rounded(px(8.0))
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .text_color(muted)
                .hover(move |s| s.bg(highlight).text_color(fg))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |this, _, _, cx| this.set_tab(next_tab, cx)),
                )
                .child(
                    Icon::new(IconName::Plus)
                        .size(px(TAB_ICON_SIZE_PX))
                        .text_color(muted),
                ),
        );

        strip.into_any_element()
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
            RightPanelTab::Database => {
                placeholder_surface("Database panel", IconName::Database, &self.tokens, muted)
            }
            RightPanelTab::Mcp => {
                placeholder_surface("MCP panel", IconName::Webhook, &self.tokens, muted)
            }
            RightPanelTab::Device => {
                placeholder_surface("Device panel", IconName::Smartphone, &self.tokens, muted)
            }
        };

        v_flex()
            .size_full()
            .bg(card_bg)
            .child(self.render_tabs(cx))
            .child(div().w_full().h(px(1.0)).bg(divider))
            .child(div().flex_1().min_h_0().w_full().child(body))
    }
}

fn next_primary_tab(current: RightPanelTab) -> RightPanelTab {
    match current {
        RightPanelTab::Files => RightPanelTab::Diff,
        RightPanelTab::Diff => RightPanelTab::Terminal,
        RightPanelTab::Terminal => RightPanelTab::Browser,
        _ => RightPanelTab::Files,
    }
}

#[expect(
    dead_code,
    reason = "called by RightPanel::render once mounted in shell"
)]
fn placeholder_surface(
    title: &str,
    icon: IconName,
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
                .child(
                    Icon::new(icon)
                        .size(px(18.0))
                        .text_color(to_hsla(tokens.foreground)),
                ),
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
