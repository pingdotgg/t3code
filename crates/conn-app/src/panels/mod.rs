//! Right-panel surfaces for `conn-app`: Conn tab header, Files explorer + source preview,
//! Diff viewer, local PTY Terminal, and Browser surface.

pub(crate) mod annotations;
mod api;
mod browser;
pub(crate) mod chrome;
mod color;
mod database;
mod device;
mod diff;
mod diff_parser;
mod files;
pub(crate) mod header;
mod highlight;
mod linked_items;
mod mcp;
mod pull_request;
mod tasks;
mod terminal;
mod terminal_palette;
mod tree;

use std::fmt;
use std::rc::Rc;

use conn_client::Connection;
use conn_state::{PanelSurface, RightPanelTab};
use conn_theme::Tokens;
use gpui_kit::component::v_flex;
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, App, Context, Entity, IntoElement, ParentElement, Render, Styled, Window, div, px,
};

use self::api::ApiPanel;
use self::browser::BrowserPanel;
use self::color::to_hsla;
use self::database::DatabasePanel;
use self::device::DevicePanel;
use self::diff::DiffPanel;
use self::files::FilesPanel;
use self::header::{PanelHeaderCallbacks, PanelHeaderProps, render_panel_header};
use self::linked_items::LinkedItemsPanel;
use self::mcp::McpPanel;
use self::pull_request::PullRequestPanel;
use self::tasks::TasksPanel;
use self::terminal::TerminalPanel;
use crate::a11y::ConnA11yExt as _;

/// What the right panel asks of the shell.
#[derive(Clone, Debug)]
pub(crate) enum RightPanelEvent {
    /// The Files tree asked to open a file as its own tab.
    OpenFile(String),
    /// A surface asked to show another surface (e.g. Linked items opening a pull request).
    OpenTab(RightPanelTab),
    /// A surface asked to send an agent prompt to the active thread (e.g. PR agent actions).
    SendPrompt(String),
    /// Browser or Device panel emitted a project annotation queue action.
    Annotation(annotations::AnnotationAction),
}

impl gpui_kit::EventEmitter<RightPanelEvent> for RightPanel {}

/// Right-panel GPUI entity mounted inside Conn's right-panel card.
#[expect(
    unreachable_pub,
    reason = "binary crate module; public API for orchestrator wiring"
)]
pub struct RightPanel {
    tokens: Tokens,
    tab: RightPanelTab,
    open_tabs: Vec<PanelSurface>,
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
    browser: Entity<BrowserPanel>,
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
        cx.subscribe(&files, |_, _, event: &files::FilesEvent, cx| match event {
            files::FilesEvent::OpenFile(path) => cx.emit(RightPanelEvent::OpenFile(path.clone())),
        })
        .detach();
        let diff = cx.new(|_| DiffPanel::new(tokens.clone(), connection.clone()));
        let terminal = cx.new(|cx| TerminalPanel::new(tokens.clone(), cx));
        let browser =
            cx.new(|cx| BrowserPanel::new(tokens.clone(), connection.clone(), window, cx));
        cx.subscribe(
            &browser,
            |_, _, action: &annotations::AnnotationAction, cx| {
                cx.emit(RightPanelEvent::Annotation(action.clone()));
            },
        )
        .detach();
        let api = cx.new(|cx| ApiPanel::new(tokens.clone(), window, cx));
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
            open_tabs: vec![PanelSurface::Kind(RightPanelTab::Files)],
            file: None,
            add_menu_open: false,
            maximized: false,
            project_id: None,
            workspace_root: None,
            thread_id: None,
            files,
            diff,
            terminal,
            browser,
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

    #[cfg(all(feature = "cef", feature = "automation"))]
    pub fn browser_preview_eval(
        &mut self,
        expression: &str,
        cx: &mut Context<'_, Self>,
    ) -> Result<tokio::sync::oneshot::Receiver<Result<serde_json::Value, String>>, String> {
        self.browser
            .update(cx, |b, _| b.start_preview_eval(expression))
    }

    #[cfg(all(feature = "cef", feature = "automation"))]
    pub fn browser_preview_call(
        &mut self,
        op: &str,
        params: &serde_json::Value,
        cx: &mut Context<'_, Self>,
    ) -> Result<tokio::sync::oneshot::Receiver<Result<serde_json::Value, String>>, String> {
        self.browser
            .update(cx, |b, _| b.start_preview_call(op, params))
    }

    #[cfg(all(feature = "cef", feature = "automation"))]
    pub fn browser_screenshot(
        &self,
        path: &std::path::Path,
        cx: &App,
    ) -> Result<serde_json::Value, String> {
        self.browser.read(cx).save_browser_screenshot(path)
    }

    /// Places an agent-provided SQL query in the Database editor without executing it.
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
        self.browser.update(cx, |p, cx| {
            p.sync_annotations(annotations.clone(), watching, project_ready, cx);
        });
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
        self.browser
            .update(cx, |p, cx| p.set_connection(connection.clone(), cx));
        self.device
            .update(cx, |p, cx| p.set_connection(connection, cx));
        cx.notify();
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
        self.browser.update(cx, |p, cx| p.set_tokens(tokens, cx));
        cx.notify();
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
            self.thread_id = thread_id.clone();
            self.diff
                .update(cx, |p, cx| p.set_thread(thread_id.clone(), cx));
        }
        let root = self.workspace_root.clone();
        for_each_thread_panel(self, root, thread_id, thread_shell, cx);
        cx.notify();
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

    fn sync_surface_visibility(&mut self, cx: &mut Context<'_, Self>) {
        let shows = |tab: RightPanelTab| self.surface_visible && self.tab == tab;
        let (show_browser, show_device) =
            (shows(RightPanelTab::Browser), shows(RightPanelTab::Device));
        let (show_diff, show_pr, show_linked) = (
            shows(RightPanelTab::Diff),
            shows(RightPanelTab::PullRequest),
            shows(RightPanelTab::LinkedItems),
        );
        self.browser
            .update(cx, |b, cx| b.set_visible(show_browser, cx));
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

    /// Switches the active right-panel tab (opening it if not yet in `open_tabs`),
    /// lazily spawning the terminal PTY on first visit.
    pub fn set_tab(&mut self, tab: RightPanelTab, cx: &mut Context<'_, Self>) {
        if tab == RightPanelTab::File {
            if let Some(path) = self.file.clone() {
                self.set_file(path, cx);
            }
            return;
        }
        let surface = PanelSurface::Kind(tab);
        if !self.open_tabs.contains(&surface) {
            self.open_tabs.push(surface);
        }
        self.add_menu_open = false;
        if tab == RightPanelTab::Files {
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

    /// Shows the file at `path` (project-relative) as its own surface, as Conn's `file` tab.
    pub fn set_file(&mut self, path: String, cx: &mut Context<'_, Self>) {
        let surface = PanelSurface::File(path.clone());
        if !self.open_tabs.contains(&surface) {
            self.open_tabs.push(surface);
        }
        self.add_menu_open = false;
        self.tab = RightPanelTab::File;
        self.file = Some(path.clone());
        self.files.update(cx, |p, cx| p.show_preview(path, cx));
        self.sync_surface_visibility(cx);
        cx.notify();
    }

    /// Shows `surface`.
    pub fn set_surface(&mut self, surface: &PanelSurface, cx: &mut Context<'_, Self>) {
        match surface {
            PanelSurface::Kind(tab) => self.set_tab(*tab, cx),
            PanelSurface::File(path) => self.set_file(path.clone(), cx),
        }
    }

    /// The active surface.
    #[must_use]
    pub fn surface(&self) -> PanelSurface {
        match (&self.tab, &self.file) {
            (RightPanelTab::File, Some(path)) => PanelSurface::File(path.clone()),
            (tab, _) => PanelSurface::Kind(*tab),
        }
    }

    /// Closes an open tab if more than one tab is open, activating an adjacent tab if needed.
    pub fn close_tab(&mut self, surface: &PanelSurface, cx: &mut Context<'_, Self>) {
        if self.open_tabs.len() <= 1 {
            return;
        }
        if let Some(pos) = self.open_tabs.iter().position(|t| t == surface) {
            self.open_tabs.remove(pos);
            if &self.surface() == surface {
                let next = self
                    .open_tabs
                    .get(pos.saturating_sub(1))
                    .cloned()
                    .unwrap_or(PanelSurface::Kind(RightPanelTab::Files));
                self.set_surface(&next, cx);
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
    pub fn open_tabs(&self) -> &[PanelSurface] {
        &self.open_tabs
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
            on_toggle_panel: Rc::new(move |_, cx| {
                entity.update(cx, |this, cx| {
                    this.add_menu_open = false;
                    cx.notify();
                });
            }),
            on_open_sidebar: Rc::new(|_, _| {}),
        };

        let active = self.surface();
        render_panel_header(
            PanelHeaderProps {
                open_tabs: &self.open_tabs,
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
    fn render(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        if self.tab == RightPanelTab::Terminal {
            self.terminal.update(cx, |p, cx| p.ensure_started(cx));
        }

        let card_bg = to_hsla(self.tokens.shell_card);
        let divider = to_hsla(self.tokens.shell_divider);
        let body: AnyElement = match self.tab {
            RightPanelTab::Files | RightPanelTab::File => self.files.clone().into_any_element(),
            RightPanelTab::Diff => self.diff.clone().into_any_element(),
            RightPanelTab::Terminal => self.terminal.clone().into_any_element(),
            RightPanelTab::Browser => self.browser.clone().into_any_element(),
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
    panel.tasks.update(cx, |p, cx| {
        p.set_project(project_key.clone(), workspace_root, cx);
    });
    panel.browser.update(cx, |p, cx| {
        p.set_project(project_key, cx);
    });
}
