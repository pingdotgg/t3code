//! Root [`ConnApp`] GPUI view holding shell state, layout state, and theme tokens.

use std::collections::{HashMap, HashSet};

use conn_client::{ClientEvent, Connection, ConnectionStatus, ServerConfig};
use conn_state::{LayoutState, RightPanelTab, ShellState, ThreadState};
use conn_theme::{ShellGeometry, Tokens};
use gpui_kit::{
    App, AppContext as _, Context, Entity, FocusHandle, Focusable, InteractiveElement as _,
    IntoElement, KeyBinding, ParentElement as _, Render, StatefulInteractiveElement as _,
    Styled as _, Window, WindowControlArea, actions, div, px,
};

use crate::fixture::demo_shell_state;
use crate::header::render_chat_header;
use crate::icons;
use crate::shell::{CardJoin, inset_card, two_tone_divider};
use crate::sidebar::rail::render_workspace_rail;
use crate::sidebar::thread_list::render_thread_sidebar;
use crate::theme::{apply_kit_theme, hsla};

actions!(conn_app, [ToggleSidebar, ToggleRightPanel]);

/// The tabs Conn shows in the right panel's header row.
const ALL_RIGHT_PANEL_TABS: [RightPanelTab; 4] = [
    RightPanelTab::Files,
    RightPanelTab::Diff,
    RightPanelTab::Terminal,
    RightPanelTab::Browser,
];

/// Registers global shell keyboard shortcuts (`Cmd+B` and `Cmd+Alt+B`).
pub(crate) fn register_keybindings(cx: &mut App) {
    crate::palette::register_keybindings(cx);
    crate::settings::register_keybindings(cx);
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
    theme_id: String,
    connection: Option<Connection>,
    status: Option<ConnectionStatus>,
    /// Timelines of subscribed threads, by thread id.
    threads: HashMap<String, ThreadState>,
    chat: Entity<crate::chat::ChatView>,
    right_panel: Entity<crate::panels::RightPanel>,
    command_palette: Option<Entity<crate::palette::CommandPalette>>,
    settings_modal: Option<Entity<crate::settings::SettingsModal>>,
    overlay_subscriptions: Vec<gpui_kit::Subscription>,
    server_url: Option<String>,
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
    /// Creates the root shell. With a server config it connects and streams the live shell;
    /// without one it shows the built-in demo fixture.
    #[must_use]
    pub(crate) fn new(
        theme_id: String,
        tokens: Tokens,
        server: Option<ServerConfig>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Self {
        let mut layout = LayoutState::default();
        let server_url = server.as_ref().map(|c| c.http_base_url.to_string());
        let chat = cx.new(|cx| crate::chat::ChatView::new(tokens.clone(), window, cx));
        cx.subscribe(
            &chat,
            |app, _chat, event: &crate::chat::ChatEvent, cx| match event {
                crate::chat::ChatEvent::Send(text) => app.send_prompt(text.clone(), cx),
                crate::chat::ChatEvent::Stop => app.stop_selected(cx),
            },
        )
        .detach();
        let (shell, connection) = match server {
            Some(config) => {
                let (connection, events) = Connection::start(config, crate::live::RT.handle());
                connection.subscribe_shell();
                Self::pump_events(events, cx);
                (ShellState::default(), Some(connection))
            }
            None => {
                let shell = demo_shell_state();
                if let Some(first_thread) = shell.threads.first() {
                    layout.selected_project_id = Some(first_thread.project_id.clone());
                    layout.selected_thread_id = Some(first_thread.id.clone());
                }
                (shell, None)
            }
        };

        let right_panel = cx.new(|cx| {
            let mut panel =
                crate::panels::RightPanel::new(tokens.clone(), connection.clone(), window, cx);
            panel.set_embedded(true, cx);
            panel
        });

        Self {
            tokens,
            geometry: ShellGeometry::default(),
            shell,
            layout,
            active_workspace: None,
            collapsed_projects: HashSet::new(),
            focus_handle: cx.focus_handle(),
            theme_id,
            connection,
            status: None,
            threads: HashMap::new(),
            chat,
            right_panel,
            command_palette: None,
            settings_modal: None,
            overlay_subscriptions: Vec::new(),
            server_url,
        }
    }

    /// Opens (or closes) the `Cmd+K` command palette.
    pub(crate) fn open_command_palette(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        use crate::palette::{CommandPalette, PaletteAction, PaletteEvent, PaletteItems};
        if self.command_palette.take().is_some() {
            cx.notify();
            return;
        }
        let items = PaletteItems::from_shell(
            &self.shell,
            self.layout.selected_thread_id.as_deref(),
            &self.theme_id,
        );
        let tokens = self.tokens.clone();
        let palette = cx.new(|cx| CommandPalette::new(items, tokens, window, cx));
        let sub = cx.subscribe_in(
            &palette,
            window,
            |app, _entity, event: &PaletteEvent, window, cx| {
                app.command_palette = None;
                match event {
                    PaletteEvent::SelectThread(id) => app.select_thread(id.clone(), cx),
                    PaletteEvent::ApplyTheme(id) => {
                        app.set_theme(id, cx);
                    }
                    PaletteEvent::Action(PaletteAction::ToggleSidebar) => app.toggle_sidebar(cx),
                    PaletteEvent::Action(PaletteAction::ToggleRightPanel) => {
                        app.toggle_right_panel(cx);
                    }
                    PaletteEvent::Action(PaletteAction::OpenPanel(tab)) => {
                        app.select_right_panel_tab(*tab, cx);
                    }
                    PaletteEvent::Action(PaletteAction::SelectProject(id)) => {
                        app.select_workspace(Some(id.clone()), cx);
                    }
                    PaletteEvent::Action(PaletteAction::OpenSettings) => {
                        app.open_settings(window, cx);
                    }
                    PaletteEvent::Dismiss => cx.notify(),
                }
            },
        );
        self.overlay_subscriptions.push(sub);
        self.command_palette = Some(palette);
        cx.notify();
    }

    /// Opens (or closes) the Settings route modal.
    pub(crate) fn open_settings(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        use crate::settings::{SettingsConnectionInfo, SettingsEvent, SettingsModal};
        if self.settings_modal.take().is_some() {
            cx.notify();
            return;
        }
        let connection = SettingsConnectionInfo {
            server_url: self.server_url.clone(),
            status: self.status.clone(),
        };
        let theme_id = self.theme_id.clone();
        let tokens = self.tokens.clone();
        let modal = cx.new(|cx| SettingsModal::new(theme_id, tokens, connection, window, cx));
        let sub = cx.subscribe(
            &modal,
            |app, _entity, event: &SettingsEvent, cx| match event {
                SettingsEvent::ApplyTheme(id) => {
                    // set_theme pushes the new tokens into the open modal too.
                    app.set_theme(id, cx);
                }
                SettingsEvent::Close => {
                    app.settings_modal = None;
                    cx.notify();
                }
            },
        );
        self.overlay_subscriptions.push(sub);
        self.settings_modal = Some(modal);
        cx.notify();
    }

    /// Pushes the selected thread's timeline (and title/model) into the chat view.
    fn sync_chat(&self, cx: &mut Context<'_, Self>) {
        let selected = self.layout.selected_thread_id.as_deref();
        let shell_thread = selected.and_then(|id| self.shell.thread(id));
        let title = shell_thread.map(|t| t.title.clone());
        let root = shell_thread.and_then(|t| {
            t.worktree_path.clone().or_else(|| {
                self.shell
                    .project(&t.project_id)
                    .map(|p| p.workspace_root.clone())
            })
        });
        let model = shell_thread.and_then(|t| t.model_selection.model.as_str().map(str::to_owned));
        let timeline = selected.and_then(|id| self.threads.get(id));
        let fallback = selected.map(conn_state::ThreadState::new);
        let thread = timeline.or(fallback.as_ref());
        let project_id = shell_thread.map(|t| t.project_id.clone());
        let thread_id = selected.map(str::to_owned);
        let tab = self.layout.right_panel_tab;
        let panel_root = root.clone();
        self.right_panel.update(cx, |panel, cx| {
            panel.set_context(project_id, panel_root, thread_id, cx);
            panel.set_tab(tab, cx);
        });
        self.chat.update(cx, |chat, cx| {
            chat.set_workspace_root(root, cx);
            chat.set_thread(thread, title, cx);
            if let Some(model) = model {
                chat.set_model_label(model, cx);
            }
        });
    }

    /// Moves connection events onto the GPUI thread, one batch per wake.
    fn pump_events(
        mut events: tokio::sync::mpsc::Receiver<ClientEvent>,
        cx: &mut Context<'_, Self>,
    ) {
        cx.spawn(async move |this, cx| {
            while let Some(first) = events.recv().await {
                let mut batch = vec![first];
                while let Ok(more) = events.try_recv() {
                    batch.push(more);
                }
                let alive = this.update(cx, |app, cx| {
                    for event in batch {
                        app.apply_event(event);
                    }
                    app.sync_chat(cx);
                    cx.notify();
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
    }

    fn apply_event(&mut self, event: ClientEvent) {
        match event {
            ClientEvent::Status(status) => self.status = Some(status),
            ClientEvent::BearerIssued(_) => {}
            ClientEvent::Shell(item) => {
                let change = self.shell.apply(item);
                if change.snapshot_required
                    && let Some(connection) = &self.connection
                {
                    connection.subscribe_shell();
                }
                if self.layout.selected_thread_id.is_none()
                    && let Some(first) = self.shell.threads.first()
                {
                    let (project_id, thread_id) = (first.project_id.clone(), first.id.clone());
                    self.layout.selected_project_id = Some(project_id);
                    self.open_thread(thread_id);
                }
            }
            ClientEvent::Thread { thread_id, item } => {
                self.threads
                    .entry(thread_id.clone())
                    .or_insert_with(|| ThreadState::new(thread_id))
                    .apply(item);
            }
            ClientEvent::StreamEnded { .. } => {}
        }
    }

    /// Selects `thread_id` and subscribes to its timeline once.
    fn open_thread(&mut self, thread_id: String) {
        if let Some(connection) = &self.connection
            && !self.threads.contains_key(&thread_id)
        {
            self.threads
                .insert(thread_id.clone(), ThreadState::new(thread_id.clone()));
            connection.subscribe_thread(&thread_id);
        }
        self.layout.selected_thread_id = Some(thread_id);
    }

    /// Sends `text` to the selected thread over `orchestration.dispatchCommand`.
    pub(crate) fn send_prompt(&mut self, text: String, cx: &mut Context<'_, Self>) {
        let (Some(connection), Some(thread_id)) = (
            self.connection.clone(),
            self.layout.selected_thread_id.clone(),
        ) else {
            return;
        };
        let working = self.threads.get(&thread_id).is_some_and(|t| t.working);
        let command = match crate::commands::send_message(&thread_id, &text, working) {
            Ok(command) => command,
            Err(e) => {
                eprintln!("send: could not build message.dispatch: {e}");
                return;
            }
        };
        cx.spawn(async move |_, _| {
            if let Err(e) = connection.dispatch_command(command).await {
                eprintln!("send: dispatchCommand failed: {e}");
            }
        })
        .detach();
    }

    /// Stops the selected thread's running turn.
    pub(crate) fn stop_selected(&mut self, cx: &mut Context<'_, Self>) {
        let (Some(connection), Some(thread_id)) = (
            self.connection.clone(),
            self.layout.selected_thread_id.clone(),
        ) else {
            return;
        };
        let Ok(command) = crate::commands::stop_thread(&thread_id) else {
            return;
        };
        cx.spawn(async move |_, _| {
            if let Err(e) = connection.dispatch_command(command).await {
                eprintln!("stop: dispatchCommand failed: {e}");
            }
        })
        .detach();
    }

    /// State read-out for the automation hook.
    #[cfg(feature = "automation")]
    pub(crate) fn automation_dump(&self) -> serde_json::Value {
        let timeline = self.selected_timeline().map(|t| {
            serde_json::json!({
                "working": t.working,
                "synchronized": t.synchronized,
                "entries": t.entries.iter().map(|e| format!("{e:?}").chars().take(120).collect::<String>()).collect::<Vec<_>>(),
            })
        });
        serde_json::json!({
            "theme": self.theme_id(),
            "live": self.connection().is_some(),
            "status": self.connection_status().map(|s| format!("{s:?}")),
            "projects": self.shell().projects.iter().map(|p| &p.title).collect::<Vec<_>>(),
            "threads": self.shell.threads.iter().map(|t| serde_json::json!({"id": t.id, "title": t.title, "activity": format!("{:?}", self.shell.activity(&t.id))})).collect::<Vec<_>>(),
            "selected": self.layout.selected_thread_id,
            "sidebarOpen": self.layout.sidebar_open,
            "rightPanel": self.layout.right_panel_open.then(|| format!("{:?}", self.layout.right_panel_tab)),
            "timeline": timeline,
        })
    }

    /// Selects a thread by id or by title (first match) for the automation hook.
    #[cfg(feature = "automation")]
    pub(crate) fn automation_select(
        &mut self,
        id: &str,
        title: &str,
        cx: &mut Context<'_, Self>,
    ) -> Result<serde_json::Value, String> {
        let found = self
            .shell
            .threads
            .iter()
            .find(|t| (!id.is_empty() && t.id == id) || (!title.is_empty() && t.title == title))
            .map(|t| t.id.clone())
            .ok_or_else(|| format!("no thread with id `{id}` or title `{title}`"))?;
        self.select_thread(found.clone(), cx);
        Ok(serde_json::json!(found))
    }

    /// Selects a thread by id, updating [`LayoutState`] and triggering a repaint.
    pub(crate) fn select_thread(
        &mut self,
        thread_id: impl Into<String>,
        cx: &mut Context<'_, Self>,
    ) {
        let thread_id = thread_id.into();
        let project_id = self.shell.thread(&thread_id).map(|t| t.project_id.clone());
        self.open_thread(thread_id);
        if project_id.is_some() {
            self.layout.selected_project_id = project_id;
        }
        self.sync_chat(cx);
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
        self.sync_chat(cx);
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
        self.sync_chat(cx);
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
    #[cfg_attr(
        not(feature = "automation"),
        expect(dead_code, reason = "read by the automation hook")
    )]
    #[must_use]
    pub(crate) fn layout(&self) -> &LayoutState {
        &self.layout
    }

    /// Current shell state.
    #[cfg_attr(
        not(feature = "automation"),
        expect(dead_code, reason = "read by the automation hook")
    )]
    #[must_use]
    pub(crate) fn shell(&self) -> &ShellState {
        &self.shell
    }

    /// Active theme tokens.
    #[cfg_attr(
        not(feature = "automation"),
        expect(dead_code, reason = "read by the automation hook")
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

        let chat_card = inset_card(&self.tokens, &self.geometry, join).child(self.chat.clone());

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

        let card = inset_card(
            &self.tokens,
            &self.geometry,
            CardJoin {
                left: true,
                right: false,
            },
        )
        .child(self.right_panel.clone());

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

/// Hooks the chat view, Settings, and the command palette call (wired in the next phases).
#[cfg_attr(
    not(feature = "automation"),
    expect(dead_code, reason = "called by views wired in later phases")
)]
impl ConnApp {
    /// The selected thread's timeline, when subscribed.
    pub(crate) fn selected_timeline(&self) -> Option<&ThreadState> {
        self.layout
            .selected_thread_id
            .as_deref()
            .and_then(|id| self.threads.get(id))
    }

    pub(crate) fn connection(&self) -> Option<&Connection> {
        self.connection.as_ref()
    }

    pub(crate) fn theme_id(&self) -> &str {
        &self.theme_id
    }

    pub(crate) fn connection_status(&self) -> Option<&ConnectionStatus> {
        self.status.as_ref()
    }

    /// Switches to a built-in theme by id. Returns false for an unknown id.
    pub(crate) fn set_theme(&mut self, theme_id: &str, cx: &mut Context<'_, Self>) -> bool {
        let Some((theme, tokens)) = crate::live::tokens_for(theme_id) else {
            return false;
        };
        self.theme_id = theme.id;
        self.set_tokens(tokens, cx);
        true
    }
    /// Replaces the active theme tokens and updates `gpui-kit`'s global theme.
    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        apply_kit_theme(&tokens, cx);
        self.chat
            .update(cx, |chat, cx| chat.set_tokens(tokens.clone(), cx));
        self.right_panel
            .update(cx, |panel, cx| panel.set_tokens(tokens.clone(), cx));
        if let Some(modal) = &self.settings_modal {
            let theme_id = self.theme_id.clone();
            modal.update(cx, |m, cx| m.set_tokens(theme_id, tokens.clone(), cx));
        }
        if let Some(palette) = &self.command_palette {
            palette.update(cx, |p, cx| p.set_tokens(tokens.clone(), cx));
        }
        self.tokens = tokens;
        cx.notify();
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
            .on_action(
                cx.listener(|app, _: &crate::palette::OpenCommandPalette, window, cx| {
                    app.open_command_palette(window, cx);
                }),
            )
            .on_action(
                cx.listener(|app, _: &crate::settings::OpenSettings, window, cx| {
                    app.open_settings(window, cx);
                }),
            )
            .relative()
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

        if let Some(modal) = &self.settings_modal {
            root = root.child(crate::settings::render_overlay(modal));
        }
        if let Some(palette) = &self.command_palette {
            root = root.child(crate::palette::render_overlay(palette));
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
