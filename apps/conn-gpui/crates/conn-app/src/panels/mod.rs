//! Right-panel surfaces for `conn-app`: Conn tab header, Files explorer + source preview,
//! Diff viewer, local PTY Terminal, and Browser surface.

mod address;
pub(crate) mod annotations;
mod api;
mod browser;
mod browser_context_menu;
pub(crate) mod chrome;
mod color;
mod database;
mod device;
mod diff;
mod diff_parser;
mod file_kind;
pub(crate) mod file_path;
mod files;
mod files_definition;
pub(crate) mod header;
mod highlight;
mod laravel_toolbar;
pub(crate) mod linked_items;
mod mcp;
mod pull_request;
mod tasks;
mod terminal;
pub(crate) mod terminal_demo;
pub(crate) mod terminal_drawer;
mod terminal_palette;
mod tree;
#[cfg(feature = "zed-files")]
pub(crate) mod zed_preview;

use std::fmt;
use std::rc::Rc;

use conn_client::Connection;
use conn_state::{AnnotationRecord, BrowserTabId, PanelSurface, RightPanelTab, RightPanelTabs};
use conn_theme::Tokens;
use gpui_kit::component::v_flex;
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, App, Context, Entity, IntoElement, ParentElement, Render, Styled, Window, div, px,
};

use self::api::ApiPanel;
use self::browser::{BrowserPanel, BrowserTabEvent};
use self::color::to_hsla;
use self::database::DatabasePanel;
use self::device::DevicePanel;
use self::diff::DiffPanel;
use self::files::FilesPanel;
use self::header::{PanelHeaderCallbacks, PanelHeaderProps, render_panel_header};
use self::laravel_toolbar::LaravelToolbarEvent;
use self::linked_items::LinkedItemsPanel;
use self::mcp::McpPanel;
use self::pull_request::PullRequestPanel;
use self::tasks::TasksPanel;
use self::terminal::TerminalPanel;
use crate::a11y::ConnA11yExt as _;

/// What the right panel asks of the shell.
#[derive(Clone, Debug)]
pub(crate) enum RightPanelEvent {
    DisplayedFileChanged,
    /// The Files tree asked to open a file as its own tab.
    OpenFile(String),
    Definition(conn_contract::source::SourceLocation),
    AttachSource(conn_contract::source::SourceSelection),
    /// A surface asked to show another surface (e.g. Linked items opening a pull request).
    OpenTab(RightPanelTab),
    /// The Files panel asked to add a file mention to the composer's draft.
    InsertMention(String),
    /// A surface asked to send an agent prompt to the active thread (e.g. PR agent actions).
    SendPrompt(String),
    /// Browser or Device panel emitted a project annotation queue action.
    Annotation(annotations::AnnotationAction),
    /// A surface or a page asked to show `url` in a new browser tab (`openUrlInPreview`).
    OpenBrowserTab {
        url: String,
        background: bool,
    },
    /// A browser tab's title changed, so the tab strip shows it.
    BrowserTitleChanged,
}

impl gpui_kit::EventEmitter<RightPanelEvent> for RightPanel {}

/// Hidden browsers kept live, across all threads. Each keeps a Chromium renderer (often a few
/// hundred MB) and its last frame in the sprite atlas. Six covers a few threads with a tab or
/// two each, the usual working set, and caps the worst case near a couple of GB.
const MAX_PARKED_BROWSERS: usize = 6;

#[cfg(test)]
pub(crate) type BrowserPanelHandle = BrowserPanel;

#[cfg(feature = "automation")]
const NO_BROWSER_TAB: &str = "No browser tab is open.";

/// Right-panel GPUI entity mounted inside Conn's right-panel card.
#[expect(
    unreachable_pub,
    reason = "binary crate module; public API for orchestrator wiring"
)]
pub struct RightPanel {
    tokens: Tokens,
    tab: RightPanelTab,
    tabs: RightPanelTabs,
    /// The open file when `tab` is [`RightPanelTab::File`].
    file: Option<String>,
    add_menu_open: bool,
    maximized: bool,
    project_id: Option<String>,
    workspace_root: Option<String>,
    thread_id: Option<String>,
    files: Entity<FilesPanel>,
    diff: Entity<DiffPanel>,
    terminal: Entity<TerminalPanel>,
    /// One browser per open browser tab, each with its own Chromium view.
    browsers: Vec<(BrowserTabId, Entity<BrowserPanel>)>,
    /// The browser tab that shows while `tab` is Browser.
    active_browser: Option<BrowserTabId>,
    /// Addresses asked for before a tab's browser exists; it loads them when made.
    pending_browser_urls: Vec<(BrowserTabId, String)>,
    /// Live browsers by when they last showed, oldest first.
    browsers_by_use: Vec<BrowserTabId>,
    /// Titles of tabs whose browser was closed to stay under [`MAX_PARKED_BROWSERS`].
    parked_titles: Vec<(BrowserTabId, String)>,
    /// What a new browser tab starts with.
    connection: Option<Connection>,
    environment_id: Option<String>,
    annotations: Option<(Vec<AnnotationRecord>, bool, bool)>,
    api: Entity<ApiPanel>,
    database: Entity<DatabasePanel>,
    mcp: Entity<McpPanel>,
    tasks: Entity<TasksPanel>,
    pull_request: Entity<PullRequestPanel>,
    linked_items: Entity<LinkedItemsPanel>,
    device: Entity<DevicePanel>,
    /// True while the right panel is open and nothing covers it (see `set_surface_visible`).
    surface_visible: bool,
    /// False when the shell draws the tab strip in its 44px glass header and the card fill.
    chrome: bool,
}

impl fmt::Debug for RightPanel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RightPanel")
            .field("tab", &self.tab)
            .field("tabs", &self.tabs)
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
        cx.subscribe(
            &files,
            |this, _, event: &files::FilesEvent, cx| match event {
                files::FilesEvent::DisplayedFileChanged => {
                    cx.emit(RightPanelEvent::DisplayedFileChanged);
                    cx.notify();
                }
                files::FilesEvent::Definition(location) => {
                    cx.emit(RightPanelEvent::Definition(location.clone()))
                }
                files::FilesEvent::Attach(s) => cx.emit(RightPanelEvent::AttachSource(s.clone())),
                files::FilesEvent::OpenFile(path) => {
                    cx.emit(RightPanelEvent::OpenFile(path.clone()))
                }
                files::FilesEvent::RevealFolder => {
                    cx.emit(RightPanelEvent::OpenTab(RightPanelTab::Files))
                }
                files::FilesEvent::AddToChat(mention) => {
                    cx.emit(RightPanelEvent::InsertMention(mention.clone()));
                }
                files::FilesEvent::OpenInBrowser(url) => {
                    let _ = this;
                    cx.emit(RightPanelEvent::OpenBrowserTab {
                        url: url.clone(),
                        background: false,
                    });
                }
            },
        )
        .detach();
        let diff = cx.new(|_| DiffPanel::new(tokens.clone(), connection.clone()));
        let terminal = cx.new(|cx| TerminalPanel::new(tokens.clone(), cx));
        let api = cx.new(|cx| ApiPanel::new(tokens.clone(), window, cx));
        let api_toolbar = api.read(cx).laravel_toolbar();
        cx.subscribe(
            &api_toolbar,
            |this, _, event: &LaravelToolbarEvent, cx| match event {
                LaravelToolbarEvent::OpenQuery(sql) => {
                    this.database
                        .update(cx, |panel, cx| panel.set_agent_sql(sql.clone(), cx));
                    cx.emit(RightPanelEvent::OpenTab(RightPanelTab::Database));
                }
            },
        )
        .detach();
        let database = cx.new(|cx| DatabasePanel::new(tokens.clone(), window, cx));
        let mcp = cx.new(|cx| McpPanel::new(tokens.clone(), window, cx));
        let tasks = cx.new(|cx| TasksPanel::new(tokens.clone(), window, cx));
        let pull_request =
            cx.new(|cx| PullRequestPanel::new(tokens.clone(), connection.clone(), window, cx));
        cx.subscribe(
            &pull_request,
            |_, _, event: &pull_request::PullRequestEvent, cx| match event {
                pull_request::PullRequestEvent::SendPrompt(prompt) => {
                    cx.emit(RightPanelEvent::SendPrompt(prompt.clone()));
                }
            },
        )
        .detach();
        let linked_items =
            cx.new(|cx| LinkedItemsPanel::new(tokens.clone(), connection.clone(), window, cx));
        let device = cx.new(|cx| DevicePanel::new(tokens.clone(), connection.clone(), window, cx));
        cx.subscribe(
            &device,
            |_, _, action: &annotations::AnnotationAction, cx| {
                cx.emit(RightPanelEvent::Annotation(action.clone()));
            },
        )
        .detach();
        cx.subscribe(&linked_items, Self::on_linked_items_event)
            .detach();

        Self {
            tokens,
            tab: RightPanelTab::Files,
            tabs: {
                let mut tabs = RightPanelTabs::default();
                tabs.activate(PanelSurface::Kind(RightPanelTab::Files));
                tabs
            },
            file: None,
            add_menu_open: false,
            maximized: false,
            project_id: None,
            workspace_root: None,
            thread_id: None,
            files,
            diff,
            terminal,
            browsers: Vec::new(),
            active_browser: None,
            pending_browser_urls: Vec::new(),
            browsers_by_use: Vec::new(),
            parked_titles: Vec::new(),
            connection,
            environment_id: None,
            annotations: None,
            api,
            database,
            mcp,
            tasks,
            pull_request,
            linked_items,
            device,
            chrome: true,
            surface_visible: false,
        }
    }

    /// Renders only the active surface; the shell owns the tab strip and the card.
    pub fn set_embedded(&mut self, embedded: bool, cx: &mut Context<'_, Self>) {
        self.chrome = !embedded;
        cx.notify();
    }

    /// Loads `url` in browser tab `id` (starting the CEF runtime on first use). A tab whose
    /// browser is not made yet loads it when it is.
    pub fn navigate_browser(&mut self, id: BrowserTabId, url: String, cx: &mut Context<'_, Self>) {
        match self.browser(id) {
            Some(browser) => browser.update(cx, |b, cx| b.navigate(url, cx)),
            None => {
                self.pending_browser_urls.retain(|(tab, _)| *tab != id);
                self.pending_browser_urls.push((id, url));
            }
        }
    }

    fn browser(&self, id: BrowserTabId) -> Option<Entity<BrowserPanel>> {
        self.browsers
            .iter()
            .find(|(tab, _)| *tab == id)
            .map(|(_, browser)| browser.clone())
    }

    #[cfg(test)]
    pub(crate) fn browser_handle(
        &self,
        id: BrowserTabId,
    ) -> Option<gpui_kit::WeakEntity<BrowserPanel>> {
        self.browser(id).map(|b| b.downgrade())
    }

    #[cfg(test)]
    pub(crate) fn browser_target(&self, id: BrowserTabId, cx: &App) -> Option<String> {
        self.browser(id).map(|b| b.read(cx).target_url().to_owned())
    }

    /// The browser tab that shows, or showed last.
    fn active_browser_entity(&self) -> Option<Entity<BrowserPanel>> {
        self.active_browser.and_then(|id| self.browser(id))
    }

    /// Browser tab `id`'s title for the tab strip (`surfaceTitle`).
    pub fn browser_tab_title(&self, id: BrowserTabId, cx: &App) -> String {
        if let Some((_, title)) = self.parked_titles.iter().find(|(tab, _)| *tab == id) {
            return title.clone();
        }
        match self.browser(id) {
            Some(browser) => browser.read(cx).tab_title(),
            None => self
                .pending_browser_urls
                .iter()
                .find(|(tab, _)| *tab == id)
                .map_or_else(
                    || conn_state::browser_tab_title("", ""),
                    |(_, url)| conn_state::browser_tab_title("", url),
                ),
        }
    }

    /// Makes browser tab `id`'s browser with what every tab shares, and loads its pending
    /// address. Needs the window, so it runs while rendering.
    fn ensure_browser(
        &mut self,
        id: BrowserTabId,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Entity<BrowserPanel> {
        if let Some(browser) = self.browser(id) {
            return browser;
        }
        let tokens = self.tokens.clone();
        let connection = self.connection.clone();
        let browser = cx.new(|cx| BrowserPanel::new(tokens, connection, window, cx));
        cx.subscribe(
            &browser,
            |_, _, action: &annotations::AnnotationAction, cx| {
                cx.emit(RightPanelEvent::Annotation(action.clone()));
            },
        )
        .detach();
        cx.subscribe(&browser, |_, _, event: &BrowserTabEvent, cx| match event {
            BrowserTabEvent::TitleChanged => cx.emit(RightPanelEvent::BrowserTitleChanged),
            BrowserTabEvent::OpenTab(request) => cx.emit(RightPanelEvent::OpenBrowserTab {
                url: request.url.clone(),
                background: request.background,
            }),
        })
        .detach();
        // "Open in Database" on a query of the debug bar.
        let toolbar = browser.read(cx).laravel_toolbar();
        cx.subscribe(
            &toolbar,
            |this, _, event: &LaravelToolbarEvent, cx| match event {
                LaravelToolbarEvent::OpenQuery(sql) => {
                    this.database
                        .update(cx, |panel, cx| panel.set_agent_sql(sql.clone(), cx));
                    cx.emit(RightPanelEvent::OpenTab(RightPanelTab::Database));
                }
            },
        )
        .detach();
        let (project, root) = (self.project_id.clone(), self.workspace_root.clone());
        let environment = self.environment_id.clone();
        let annotations = self.annotations.clone();
        let pending = self
            .pending_browser_urls
            .iter()
            .position(|(tab, _)| *tab == id)
            .map(|index| self.pending_browser_urls.remove(index).1);
        browser.update(cx, |b, cx| {
            b.set_project(project, cx);
            b.set_workspace_root(root, cx);
            if let Some(environment) = environment {
                b.set_environment(environment, cx);
            }
            if let Some((records, watching, ready)) = annotations {
                b.sync_annotations(records, watching, ready, cx);
            }
            if let Some(url) = pending {
                b.navigate(url, cx);
            }
        });
        self.parked_titles.retain(|(tab, _)| *tab != id);
        self.browsers.push((id, browser.clone()));
        // The newest browser is the last the cap closes.
        self.browsers_by_use.retain(|tab| *tab != id);
        self.browsers_by_use.push(id);
        self.sync_surface_visibility(cx);
        browser
    }

    /// Closes the least recently shown hidden browsers beyond [`MAX_PARKED_BROWSERS`]. Their
    /// tabs stay with address and title, and load again when shown. This bounds the Chromium
    /// views of tabs left open in threads the user moved on from, or that went away.
    fn evict_parked_browsers(&mut self, cx: &App) {
        let shown = self.shown_browser();
        let parked = self
            .browsers_by_use
            .iter()
            .filter(|id| Some(**id) != shown)
            .count();
        let over = parked.saturating_sub(MAX_PARKED_BROWSERS);
        let evicted: Vec<BrowserTabId> = self
            .browsers_by_use
            .iter()
            .copied()
            .filter(|id| Some(*id) != shown)
            .take(over)
            .collect();
        for id in evicted {
            self.browsers_by_use.retain(|tab| *tab != id);
            let Some(index) = self.browsers.iter().position(|(tab, _)| *tab == id) else {
                continue;
            };
            let (_, browser) = self.browsers.remove(index);
            let page = browser.read(cx);
            let (url, title) = (page.page_url(), page.tab_title());
            // Dropping the last handle releases its frame and closes its Chromium view.
            drop(browser);
            self.pending_browser_urls.retain(|(tab, _)| *tab != id);
            self.pending_browser_urls.push((id, url));
            self.parked_titles.push((id, title));
        }
    }

    /// The browser tab on screen, if one is.
    fn shown_browser(&self) -> Option<BrowserTabId> {
        (self.surface_visible && self.tab == RightPanelTab::Browser)
            .then_some(self.active_browser)
            .flatten()
    }

    /// Drops a closed browser tab's browser and its pending address. Only that tab: the shell
    /// can hold tabs this panel has not shown yet (a background tab), and their addresses stay.
    /// Dropping the browser releases its last frame and closes its Chromium view.
    fn drop_browser(&mut self, surface: &PanelSurface) {
        let PanelSurface::Browser(closed) = *surface else {
            return;
        };
        self.browsers.retain(|(id, _)| *id != closed);
        self.pending_browser_urls.retain(|(id, _)| *id != closed);
        self.browsers_by_use.retain(|id| *id != closed);
        self.parked_titles.retain(|(id, _)| *id != closed);
        if self.active_browser == Some(closed) {
            self.active_browser = None;
        }
    }

    /// Browser tab `id`'s browser for the automation hook. `id` is a tab of the shown thread, so
    /// another thread's page is never the one acted on; none means that thread has no browser
    /// tab. A tab whose browser the cap closed gets a new one loading its saved address, as
    /// showing it does, and makes its page even while hidden so the command can reach it.
    #[cfg(feature = "automation")]
    fn automation_browser(
        &mut self,
        id: Option<BrowserTabId>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Result<Entity<BrowserPanel>, String> {
        let id = id.ok_or_else(|| NO_BROWSER_TAB.to_owned())?;
        if let Some(browser) = self.browser(id) {
            return Ok(browser);
        }
        // Every browser fills the same panel area, so a live one's bounds fit the new page.
        let bounds = self
            .browsers
            .iter()
            .find_map(|(_, browser)| browser.read(cx).web_bounds());
        let browser = self.ensure_browser(id, window, cx);
        browser.update(cx, |b, cx| b.make_view_while_hidden(bounds, cx));
        Ok(browser)
    }

    /// Diagnostic state of browser tab `id`.
    #[cfg(feature = "automation")]
    pub fn browser_state(
        &mut self,
        id: Option<BrowserTabId>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Result<serde_json::Value, String> {
        let mut state = self
            .automation_browser(id, window, cx)?
            .read(cx)
            .automation_state();
        if let Some(object) = state.as_object_mut() {
            object.insert("tabCount".into(), self.browsers.len().into());
        }
        Ok(state)
    }

    /// Browser tab `id`'s page title (empty before a page loads).
    #[cfg(feature = "automation")]
    pub fn browser_title(
        &mut self,
        id: Option<BrowserTabId>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Result<String, String> {
        Ok(self.automation_browser(id, window, cx)?.read(cx).title())
    }

    #[cfg(feature = "automation")]
    pub fn browser_preview_eval(
        &mut self,
        id: Option<BrowserTabId>,
        expression: &str,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Result<tokio::sync::oneshot::Receiver<Result<serde_json::Value, String>>, String> {
        self.automation_browser(id, window, cx)?
            .update(cx, |b, _| b.start_preview_eval(expression))
    }

    #[cfg(feature = "automation")]
    pub fn browser_preview_call(
        &mut self,
        id: Option<BrowserTabId>,
        op: &str,
        params: &serde_json::Value,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Result<tokio::sync::oneshot::Receiver<Result<serde_json::Value, String>>, String> {
        self.automation_browser(id, window, cx)?
            .update(cx, |b, _| b.start_preview_call(op, params))
    }

    #[cfg(feature = "automation")]
    pub fn browser_screenshot(
        &mut self,
        id: Option<BrowserTabId>,
        path: &std::path::Path,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Result<serde_json::Value, String> {
        self.automation_browser(id, window, cx)?
            .read(cx)
            .save_browser_screenshot(path)
    }

    /// Places an agent-provided SQL query in the Database editor without executing it.
    /// Shows `surface` with the panel visible or not, in that order: the surface it leaves and
    /// the one it picks see the new visibility, so a closed panel's browser runs no script.
    pub fn show_surface(
        &mut self,
        surface: &PanelSurface,
        visible: bool,
        cx: &mut Context<'_, Self>,
    ) {
        self.surface_visible = visible;
        self.set_surface(surface, cx);
        self.sync_surface_visibility(cx);
    }

    pub fn set_database_sql(&mut self, sql: String, cx: &mut Context<'_, Self>) {
        self.database
            .update(cx, |panel, cx| panel.set_agent_sql(sql, cx));
    }

    /// Runs an agent's read-only SQL query in the Database panel and resolves with its result.
    pub fn run_agent_database_query(
        &mut self,
        sql: String,
        connection: Option<String>,
        cx: &mut Context<'_, Self>,
    ) -> tokio::sync::oneshot::Receiver<Result<conn_contract::AgentPanelDatabaseResult, String>>
    {
        self.database
            .update(cx, |panel, cx| panel.run_agent_query(sql, connection, cx))
    }

    /// Connects an MCP server in the MCP panel for an agent and resolves with its tools list.
    pub fn run_agent_mcp_connect(
        &mut self,
        spec: conn_contract::AgentPanelMcpServer,
        cx: &mut Context<'_, Self>,
    ) -> tokio::sync::oneshot::Receiver<Result<conn_contract::AgentPanelMcpResult, String>> {
        self.mcp
            .update(cx, |panel, cx| panel.run_agent_connect(spec, cx))
    }

    /// Calls an MCP tool in the MCP panel for an agent and resolves with its output.
    pub fn run_agent_mcp_call(
        &mut self,
        call: conn_contract::AgentPanelMcpCall,
        cx: &mut Context<'_, Self>,
    ) -> tokio::sync::oneshot::Receiver<Result<conn_contract::AgentPanelMcpCallResult, String>>
    {
        self.mcp
            .update(cx, |panel, cx| panel.run_agent_call(call, cx))
    }

    /// Subscribes to app-wide Orbit Gateway Reverb events from the shared Tasks WebSocket.
    pub fn subscribe_orbit_events(
        &self,
        cx: &App,
    ) -> Option<tokio::sync::broadcast::Receiver<conn_desktop::orbit::OrbitRealtimeEvent>> {
        self.tasks.read(cx).subscribe_orbit_events()
    }

    /// Syncs the active project's live annotations queue and Watch state into Browser and Device.
    pub fn set_annotations(
        &mut self,
        annotations: Vec<conn_state::AnnotationRecord>,
        watching: bool,
        project_ready: bool,
        cx: &mut Context<'_, Self>,
    ) {
        self.annotations = Some((annotations.clone(), watching, project_ready));
        self.refresh_shown_browser(cx);
        self.device.update(cx, |p, cx| {
            p.sync_annotations(annotations, watching, project_ready, cx);
        });
    }

    /// Updates the live `conn-server` connection across every server-backed right-panel surface.
    pub fn set_connection(&mut self, connection: Option<Connection>, cx: &mut Context<'_, Self>) {
        self.files
            .update(cx, |p, cx| p.set_connection(connection.clone(), cx));
        self.diff
            .update(cx, |p, cx| p.set_connection(connection.clone(), cx));
        self.pull_request
            .update(cx, |p, cx| p.set_connection(connection.clone(), cx));
        self.linked_items
            .update(cx, |p, cx| p.set_connection(connection.clone(), cx));
        for (_, browser) in &self.browsers {
            browser.update(cx, |p, cx| p.set_connection(connection.clone(), cx));
        }
        self.device
            .update(cx, |p, cx| p.set_connection(connection.clone(), cx));
        self.connection = connection;
        cx.notify();
    }

    /// Hands the live server config to the surfaces that read its settings.
    pub fn set_server_config(
        &mut self,
        config: std::sync::Arc<conn_state::providers::ServerConfigState>,
        cx: &mut Context<'_, Self>,
    ) {
        self.device
            .update(cx, |panel, cx| panel.set_server_config(config, cx));
    }

    /// The terminal view, which the shell also hosts as a bottom drawer under the chat.
    pub(crate) fn terminal_entity(&self) -> Entity<TerminalPanel> {
        self.terminal.clone()
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
        self.database
            .update(cx, |p, cx| p.set_tokens(tokens.clone(), cx));
        self.mcp
            .update(cx, |p, cx| p.set_tokens(tokens.clone(), cx));
        self.tasks
            .update(cx, |p, cx| p.set_tokens(tokens.clone(), cx));
        self.pull_request
            .update(cx, |p, cx| p.set_tokens(tokens.clone(), cx));
        self.linked_items
            .update(cx, |p, cx| p.set_tokens(tokens.clone(), cx));
        self.device
            .update(cx, |p, cx| p.set_tokens(tokens.clone(), cx));
        for (_, browser) in &self.browsers {
            browser.update(cx, |p, cx| p.set_tokens(tokens.clone(), cx));
        }
        cx.notify();
    }

    /// The Conn server (Orbit environment) the thread runs on.
    pub fn set_environment(&mut self, environment_id: String, cx: &mut Context<'_, Self>) {
        self.api.update(cx, |api, cx| {
            api.set_environment(environment_id.clone(), cx)
        });
        for (_, browser) in &self.browsers {
            browser.update(cx, |b, cx| b.set_environment(environment_id.clone(), cx));
        }
        self.environment_id = Some(environment_id);
    }

    /// Updates the active project, workspace root, and thread context.
    pub fn set_context(
        &mut self,
        project_id: Option<String>,
        workspace_root: Option<String>,
        thread_id: Option<String>,
        thread_shell: Option<&conn_state::ThreadShell>,
        cx: &mut Context<'_, Self>,
    ) {
        if self.project_id != project_id || self.workspace_root != workspace_root {
            let key = project_id.clone();
            self.api.update(cx, |p, cx| p.set_project(key.clone(), cx));
            for_each_project_panel(self, key, workspace_root.clone(), cx);
        }
        self.project_id = project_id;
        if self.workspace_root != workspace_root {
            self.workspace_root = workspace_root.clone();
            self.files
                .update(cx, |p, cx| p.set_workspace_root(workspace_root.clone(), cx));
            self.diff
                .update(cx, |p, cx| p.set_workspace_root(workspace_root.clone(), cx));
            self.terminal
                .update(cx, |p, cx| p.set_workspace_root(workspace_root, cx));
        }
        if self.thread_id != thread_id {
            self.files
                .update(cx, |files, cx| files.set_thread(thread_id.clone(), cx));
            self.thread_id = thread_id.clone();
            self.files
                .update(cx, |p, _| p.set_signing_thread(thread_id.clone()));
            self.diff
                .update(cx, |p, cx| p.set_thread(thread_id.clone(), cx));
        }
        let root = self.workspace_root.clone();
        for_each_thread_panel(self, root, thread_id, thread_shell, cx);
        cx.notify();
    }

    /// The browser that shows gets the shown thread's project and annotations. Hidden ones,
    /// which may belong to other threads, get nothing: each script call reaches a live page.
    /// A hidden page catches up from its own thread's project when it shows again.
    fn refresh_shown_browser(&self, cx: &mut Context<'_, Self>) {
        if !self.surface_visible || self.tab != RightPanelTab::Browser {
            return;
        }
        let Some(browser) = self.active_browser_entity() else {
            return;
        };
        let (project, root) = (self.project_id.clone(), self.workspace_root.clone());
        let annotations = self.annotations.clone();
        browser.update(cx, |p, cx| {
            p.set_project(project, cx);
            p.set_workspace_root(root, cx);
            if let Some((annotations, watching, ready)) = annotations {
                p.sync_annotations(annotations, watching, ready, cx);
            }
        });
    }

    /// Optional hint for the active thread's completed turn count used by `orchestration.getFullThreadDiff`.
    pub fn set_turn_count(&mut self, turn_count: Option<i64>, cx: &mut Context<'_, Self>) {
        self.diff
            .update(cx, |p, cx| p.set_turn_count(turn_count, cx));
    }

    /// Whether live surfaces (native CEF browser view, device video/input streams) may run:
    /// the shell passes `true` only when the right panel is open and no GPUI overlay covers it.
    pub fn set_surface_visible(&mut self, visible: bool, cx: &mut Context<'_, Self>) {
        self.surface_visible = visible;
        self.sync_surface_visibility(cx);
    }

    #[cfg(feature = "zed-files")]
    pub(crate) fn file_modifiers_changed(
        &self,
        modifiers: gpui_kit::Modifiers,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if self.surface_visible && self.tab == RightPanelTab::File {
            self.files.update(cx, |panel, cx| {
                if modifiers == gpui_kit::Modifiers::command() {
                    panel.zed_definition_at(window.mouse_position(), false, window, cx);
                } else {
                    panel.cancel_hover();
                }
            });
        }
    }

    fn sync_surface_visibility(&mut self, cx: &mut Context<'_, Self>) {
        if !self.surface_visible || self.tab != RightPanelTab::File {
            self.files.update(cx, |files, _| files.cancel_reveal());
        }
        let shows = |tab: RightPanelTab| self.surface_visible && self.tab == tab;
        let (show_browser, show_device) =
            (shows(RightPanelTab::Browser), shows(RightPanelTab::Device));
        let (show_diff, show_pr, show_linked) = (
            shows(RightPanelTab::Diff),
            shows(RightPanelTab::PullRequest),
            shows(RightPanelTab::LinkedItems),
        );
        for (id, browser) in &self.browsers {
            let show = show_browser && self.active_browser == Some(*id);
            browser.update(cx, |b, cx| b.set_visible(show, cx));
        }
        if let Some(shown) = self.shown_browser()
            && self.browser(shown).is_some()
        {
            self.browsers_by_use.retain(|id| *id != shown);
            self.browsers_by_use.push(shown);
        }
        self.evict_parked_browsers(cx);
        self.refresh_shown_browser(cx);
        self.device
            .update(cx, |d, cx| d.set_visible(show_device, cx));
        // Diff, Pull request and Linked items load only while shown, as in Conn. Before, every
        // thread switch fired their git, GitHub and three full `getThreadProjection` calls
        // whether or not the right panel was open, competing with the thread snapshot.
        self.diff.update(cx, |p, cx| p.set_active(show_diff, cx));
        self.pull_request
            .update(cx, |p, cx| p.set_active(show_pr, cx));
        self.linked_items
            .update(cx, |p, cx| p.set_active(show_linked, cx));
    }

    /// Switches the active right-panel tab (opening it if not yet open), lazily spawning the
    /// terminal PTY on first visit. Browser shows the browser tab shown last, or a new one.
    pub fn set_tab(&mut self, tab: RightPanelTab, cx: &mut Context<'_, Self>) {
        if tab == RightPanelTab::File {
            if let Some(path) = self.file.clone() {
                self.set_file(path, cx);
            }
            return;
        }
        if tab == RightPanelTab::Browser {
            let surface = self.tabs.open(RightPanelTab::Browser);
            self.set_surface(&surface, cx);
            return;
        }
        self.tabs.activate(PanelSurface::Kind(tab));
        self.add_menu_open = false;
        if self.tab == RightPanelTab::File || tab == RightPanelTab::Files {
            self.files.update(cx, |p, cx| p.show_tree(cx));
        }
        if self.tab == tab {
            cx.notify();
            return;
        }
        self.tab = tab;
        self.sync_surface_visibility(cx);
        if tab == RightPanelTab::Terminal {
            self.terminal.update(cx, |p, cx| p.ensure_started(cx));
        }
        cx.notify();
    }

    /// Shows browser tab `id`, opening it if it is new.
    fn set_browser(&mut self, id: BrowserTabId, cx: &mut Context<'_, Self>) {
        self.tabs.activate(PanelSurface::Browser(id));
        self.add_menu_open = false;
        self.tab = RightPanelTab::Browser;
        self.active_browser = Some(id);
        self.sync_surface_visibility(cx);
        cx.notify();
    }

    /// Reveals `line` of the file tab now showing (or loading) and flashes it.
    pub fn reveal_line(&mut self, line: usize, cx: &mut Context<'_, Self>) {
        self.files.update(cx, |p, cx| p.reveal_line(line, cx));
    }

    #[cfg(feature = "automation")]
    pub(crate) fn spike_files_state(
        &self,
        window: &Window,
        cx: &gpui_kit::App,
    ) -> serde_json::Value {
        self.files.read(cx).spike_files_state(window, cx)
    }
    pub(crate) fn selected_source(
        &self,
        cx: &gpui_kit::App,
    ) -> Option<conn_contract::source::SourceSelection> {
        (self.tab == RightPanelTab::File)
            .then(|| self.files.read(cx).selected_source(cx))
            .flatten()
    }

    pub(crate) fn reveal_lines(
        &mut self,
        path: String,
        lines: conn_contract::source::SourceLines,
        excerpt: Option<String>,
        cx: &mut Context<'_, Self>,
    ) -> tokio::sync::oneshot::Receiver<Result<(), String>> {
        self.files
            .update(cx, |files, cx| files.reveal_lines(path, lines, excerpt, cx))
    }

    /// Shows the file at `path` (project-relative) as its own surface, as Conn's `file` tab.
    pub fn set_file(&mut self, path: String, cx: &mut Context<'_, Self>) {
        self.tabs.activate(PanelSurface::File(path.clone()));
        self.add_menu_open = false;
        self.tab = RightPanelTab::File;
        self.file = Some(path.clone());
        self.files.update(cx, |p, cx| p.show_preview_at(path, cx));
        self.sync_surface_visibility(cx);
        cx.notify();
    }

    /// Shows `surface`.
    pub fn set_surface(&mut self, surface: &PanelSurface, cx: &mut Context<'_, Self>) {
        match surface {
            PanelSurface::Kind(tab) => self.set_tab(*tab, cx),
            PanelSurface::File(path) => self.set_file(path.clone(), cx),
            PanelSurface::Browser(id) => self.set_browser(*id, cx),
        }
    }

    pub(crate) fn displayed_surface(
        &self,
        requested: PanelSurface,
        tabs: &[PanelSurface],
        cx: &gpui_kit::App,
    ) -> PanelSurface {
        if matches!(requested, PanelSurface::File(_))
            && let Some(held) = self.files.read(cx).held_file()
            && let Some(tab) = tabs.iter().find(|tab| matches!(tab, PanelSurface::File(path) if file_path::split_line_suffix(path).0 == held))
        {
            return tab.clone();
        }
        requested
    }

    /// The active surface.
    #[must_use]
    pub fn surface(&self) -> PanelSurface {
        match (&self.tab, &self.file, self.active_browser) {
            (RightPanelTab::File, Some(path), _) => PanelSurface::File(path.clone()),
            (RightPanelTab::Browser, _, Some(id)) => PanelSurface::Browser(id),
            (tab, _, _) => PanelSurface::Kind(*tab),
        }
    }

    /// Forgets a tab the shell closed; a browser tab's Chromium view closes with it.
    pub fn close_surface(&mut self, surface: &PanelSurface, cx: &mut Context<'_, Self>) {
        self.tabs.close(surface);
        self.drop_browser(surface);
        self.release_closed_file(surface, cx);
        cx.notify();
    }

    pub(crate) fn release_closed_file(&mut self, tab: &PanelSurface, cx: &mut Context<'_, Self>) {
        if let PanelSurface::File(path) = tab {
            self.files.update(cx, |files, cx| {
                files.release_closed_file(file_path::split_line_suffix(path).0, cx)
            });
        }
    }

    /// Closes an open tab if more than one tab is open, activating an adjacent tab if needed.
    pub fn close_tab(&mut self, surface: &PanelSurface, cx: &mut Context<'_, Self>) {
        if self.tabs.tabs().len() <= 1 {
            return;
        }
        if let Some(closed) = self.tabs.close(surface) {
            self.drop_browser(surface);
            self.release_closed_file(surface, cx);
            if let Some(next) = closed.activated {
                self.set_surface(&next, cx);
            }
            cx.notify();
        }
    }

    /// The add menu's choice: Browser adds a new tab, other kinds show their one tab.
    fn add_tab(&mut self, tab: RightPanelTab, cx: &mut Context<'_, Self>) {
        let surface = self.tabs.add(tab);
        self.set_surface(&surface, cx);
    }

    /// Returns the currently active right-panel tab.
    #[must_use]
    pub fn tab(&self) -> RightPanelTab {
        self.tab
    }

    /// Returns the list of currently open right-panel tabs.
    #[must_use]
    pub fn open_tabs(&self) -> &[PanelSurface] {
        self.tabs.tabs()
    }

    /// The titles of browser tabs `ids`, for the tab strip.
    #[must_use]
    pub fn browser_titles(
        &self,
        ids: impl IntoIterator<Item = BrowserTabId>,
        cx: &App,
    ) -> Vec<(BrowserTabId, String)> {
        ids.into_iter()
            .map(|id| (id, self.browser_tab_title(id, cx)))
            .collect()
    }

    /// Renders the 44px header tab strip (`RightPanelTabs`), suitable for mounting either
    /// inside [`RightPanel::render`] or directly in the shell's glass header row.
    pub fn render_tabs(&self, cx: &mut Context<'_, Self>) -> AnyElement {
        let entity = cx.entity();
        let callbacks = PanelHeaderCallbacks {
            on_select_tab: {
                let entity = entity.clone();
                Rc::new(move |surface: PanelSurface, _, cx| {
                    entity.update(cx, |this, cx| this.set_surface(&surface, cx));
                })
            },
            on_close_tab: Some({
                let entity = entity.clone();
                Rc::new(move |surface: PanelSurface, _, cx| {
                    entity.update(cx, |this, cx| this.close_tab(&surface, cx));
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
                    entity.update(cx, |this, cx| this.add_tab(tab, cx));
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
            on_toggle_panel: Rc::new(move |_, cx| {
                entity.update(cx, |this, cx| {
                    this.add_menu_open = false;
                    cx.notify();
                });
            }),
            on_open_sidebar: Rc::new(|_, _| {}),
        };

        let active = self.displayed_surface(self.surface(), self.tabs.tabs(), cx);
        let browser_titles = self.browser_titles(self.tabs.browser_ids(), cx);
        render_panel_header(
            PanelHeaderProps {
                open_tabs: self.tabs.tabs(),
                browser_titles: &browser_titles,
                active_tab: &active,
                maximized: self.maximized,
                owns_window_leading_edge: false,
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
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        if self.tab == RightPanelTab::Terminal {
            self.terminal.update(cx, |p, cx| p.ensure_started(cx));
        }

        let card_bg = to_hsla(self.tokens.shell_card);
        let divider = to_hsla(self.tokens.shell_divider);
        let body: AnyElement = match self.tab {
            RightPanelTab::Files | RightPanelTab::File => self.files.clone().into_any_element(),
            RightPanelTab::Diff => self.diff.clone().into_any_element(),
            RightPanelTab::Terminal => self.terminal.clone().into_any_element(),
            RightPanelTab::Browser => match self.active_browser {
                Some(id) => self.ensure_browser(id, window, cx).into_any_element(),
                None => div().into_any_element(),
            },
            RightPanelTab::Api => self.api.clone().into_any_element(),
            RightPanelTab::Database => self.database.clone().into_any_element(),
            RightPanelTab::Mcp => self.mcp.clone().into_any_element(),
            RightPanelTab::Tasks => self.tasks.clone().into_any_element(),
            RightPanelTab::PullRequest => self.pull_request.clone().into_any_element(),
            RightPanelTab::LinkedItems => self.linked_items.clone().into_any_element(),
            RightPanelTab::Device => self.device.clone().into_any_element(),
        };

        let surface_label = header::panel_tab_label(self.tab);
        let surface_ax_id = gpui_kit::SharedString::from(format!(
            "panel.surface.{}",
            surface_label.to_ascii_lowercase().replace(' ', "-")
        ));
        let wrapped_body = div()
            .id(gpui_kit::SharedString::from(format!(
                "right-panel-surface-{surface_label}"
            )))
            .a11y(gpui_kit::Role::TabPanel, surface_ax_id, surface_label)
            .flex_1()
            .min_h_0()
            .w_full()
            .child(body);

        if !self.chrome {
            return v_flex().size_full().child(wrapped_body);
        }
        v_flex()
            .size_full()
            .bg(card_bg)
            .child(self.render_tabs(cx))
            .child(div().w_full().h(px(1.0)).bg(divider))
            .child(wrapped_body)
    }
}

/// Hands the selected thread's project and folder to the project-scoped surfaces.
impl RightPanel {
    fn on_linked_items_event(
        &mut self,
        _: Entity<LinkedItemsPanel>,
        event: &linked_items::LinkedItemsEvent,
        cx: &mut Context<'_, Self>,
    ) {
        match event {
            linked_items::LinkedItemsEvent::OpenPullRequest {
                project_id,
                host,
                repository,
                number,
                url,
            } => {
                let Some(project_id) = project_id.clone().or_else(|| self.project_id.clone())
                else {
                    open_external(url);
                    return;
                };
                let (host, repository, number, url) =
                    (host.clone(), repository.clone(), *number, url.clone());
                self.pull_request.update(cx, |p, cx| {
                    p.open_pull_request(project_id, Some(host), repository, number, Some(url), cx);
                });
                self.set_tab(RightPanelTab::PullRequest, cx);
                cx.emit(RightPanelEvent::OpenTab(RightPanelTab::PullRequest));
            }
            // Conn opens an Issue surface; until conn-gpui has one, the tracker's page.
            linked_items::LinkedItemsEvent::OpenIssue { url, .. } => open_external(url),
        }
    }
}

/// Opens `url` in the default browser.
fn open_external(url: &str) {
    if let Err(err) = std::process::Command::new("open").arg(url).spawn() {
        log::warn!("could not open {url}: {err}");
    }
}

/// Hands the selected thread and its folder to the thread-scoped surfaces.
fn for_each_thread_panel(
    panel: &RightPanel,
    workspace_root: Option<String>,
    thread_id: Option<String>,
    thread_shell: Option<&conn_state::ThreadShell>,
    cx: &mut Context<'_, RightPanel>,
) {
    let pr_fields = thread_shell.map(pull_request::PrThreadFields::from);
    panel.pull_request.update(cx, |p, cx| {
        p.set_thread(workspace_root.clone(), thread_id.clone(), pr_fields, cx);
    });
    let linked_shell = thread_shell.map(conn_contract::to_json);
    panel.linked_items.update(cx, |p, cx| {
        p.set_thread(workspace_root.clone(), thread_id.clone(), linked_shell, cx);
    });
    panel.device.update(cx, |p, cx| {
        p.set_thread(workspace_root, thread_id, cx);
    });
}

fn for_each_project_panel(
    panel: &RightPanel,
    project_key: Option<String>,
    workspace_root: Option<String>,
    cx: &mut Context<'_, RightPanel>,
) {
    panel.database.update(cx, |p, cx| {
        p.set_project(project_key.clone(), workspace_root.clone(), cx);
    });
    panel.mcp.update(cx, |p, cx| {
        p.set_project(project_key.clone(), workspace_root.clone(), cx);
    });
    panel
        .api
        .update(cx, |p, cx| p.set_workspace_root(workspace_root.clone(), cx));
    panel.tasks.update(cx, |p, cx| {
        p.set_project(project_key, workspace_root, cx);
    });
}
