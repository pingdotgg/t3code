//! Root [`ConnApp`] GPUI view holding shell state, layout state, and theme tokens.

use std::collections::{HashMap, HashSet};

use conn_client::{ClientEvent, Connection, ConnectionStatus, ServerConfig};
use conn_state::{LayoutState, PanelSurface, RightPanelTab, ShellState, ThreadState};
use conn_theme::{ShellGeometry, Tokens};
use gpui_kit::{
    App, AppContext as _, Context, Entity, FocusHandle, Focusable, InteractiveElement as _,
    IntoElement, KeyBinding, ParentElement as _, Render, Styled as _, Window, actions, div, px,
};

use crate::a11y::ConnA11yExt as _;
use crate::fixture::demo_shell_state;
use crate::header::render_chat_header;
use crate::shell::{CardJoin, inset_card, two_tone_divider};
use crate::sidebar::rail::render_workspace_rail;
use crate::sidebar::thread_list::render_thread_sidebar;
use crate::theme::{apply_kit_theme, hsla};

actions!(conn_app, [ToggleSidebar, ToggleRightPanel, NewThread]);

/// Registers global shell keyboard shortcuts (`Cmd+B` and `Cmd+Alt+B`).
pub(crate) fn register_keybindings(cx: &mut App) {
    crate::palette::register_keybindings(cx);
    crate::settings::register_keybindings(cx);
    cx.bind_keys([
        KeyBinding::new("cmd-b", ToggleSidebar, None),
        KeyBinding::new("cmd-alt-b", ToggleRightPanel, None),
        KeyBinding::new("cmd-n", NewThread, None),
    ]);
}

/// A panel seam being dragged: which side, where the drag started, and the width then.
#[derive(Clone, Copy, Debug, PartialEq)]
enum SeamDrag {
    Sidebar { from_x: f32, start: f32 },
    RightPanel { from_x: f32, start: f32 },
}

/// State of a brand-new thread draft being composed before `orchestration.launchThread`.
#[derive(Clone, Debug)]
struct DraftThreadState {
    project_id: String,
    model_instance_id: Option<String>,
    model_slug: Option<String>,
    model_options: Option<serde_json::Map<String, serde_json::Value>>,
    runtime_mode: String,
    interaction_mode: String,
    use_worktree: bool,
    launching: bool,
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
    /// True when the active connection came from `CONN_GPUI_*` env vars (skip overwriting
    /// persisted user `server.json`).
    env_pinned_server: bool,
    /// Timelines of subscribed threads, by thread id.
    threads: HashMap<String, ThreadState>,
    chat: Entity<crate::chat::ChatView>,
    right_panel: Entity<crate::panels::RightPanel>,
    /// Thread streams the server ended (for example a thread launched a moment before the
    /// server knew it). Resubscribed once the shell lists the thread.
    ended_threads: HashSet<String>,
    /// Active new-thread draft; sent with `orchestration.launchThread` on first message.
    draft: Option<DraftThreadState>,
    /// Right panel tabs the user has open, in order (Conn's `RightPanelTabs`).
    right_panel_open_tabs: Vec<PanelSurface>,
    /// The open file while `layout.right_panel_tab` is [`RightPanelTab::File`].
    right_panel_file: Option<String>,
    right_panel_add_menu_open: bool,
    right_panel_maximized: bool,
    seam_drag: Option<SeamDrag>,
    command_palette: Option<Entity<crate::palette::CommandPalette>>,
    settings_modal: Option<Entity<crate::settings::SettingsModal>>,
    overlay_subscriptions: Vec<gpui_kit::Subscription>,
    /// What had the keyboard before the palette or Settings opened; it gets it back on close.
    focus_before_overlay: Option<FocusHandle>,
    /// Live search box at the top of the thread sidebar.
    sidebar_search_input: Entity<gpui_kit::component::input::InputState>,
    _sidebar_search_sub: gpui_kit::Subscription,
    /// Inline thread-title rename state (`thread_id` being edited + focused input).
    renaming_thread_id: Option<String>,
    rename_input: Entity<gpui_kit::component::input::InputState>,
    _rename_sub: gpui_kit::Subscription,
    /// Whether the sidebar project-scope filter popover is open.
    sidebar_filter_menu_open: bool,
    /// When true, replaces translucent shell fills with opaque `sidebar`/`shell_card`.
    reduce_transparency: bool,
    server_url: Option<String>,
    server_label: Option<String>,
    /// Monotonic counter incremented on every live server switch so stale event pumps stop cleanly.
    connection_gen: u64,
    /// Orbit Gateway Nodes/Instances, profile, workspace, theme, and desktop settings sync state.
    orbit: crate::orbit_sync::OrbitSyncState,
    /// Thread id requested via `conn://thread/...` or control socket while switching servers.
    pending_open_thread: Option<String>,
    /// Live control socket server handle (dropped on app exit).
    _control_server: Option<conn_desktop::control::ControlServerHandle>,
    /// Background task draining `conn://` URLs and Unix control socket requests.
    _activation_task: Option<gpui_kit::Task<()>>,
    /// Thread id currently subscribed via `orchestration.subscribeThread` on `self.connection`.
    subscribed_thread_id: Option<String>,
    /// Project id currently subscribed to `annotations.subscribe` on `self.connection`.
    subscribed_annotation_project: Option<String>,
    /// Live annotations queue for `subscribed_annotation_project`.
    annotations: Vec<conn_state::AnnotationRecord>,
    /// Threads with automatic annotation Watch enabled.
    annotation_watching_threads: HashSet<String>,
    /// Waiting annotation ids already sent to each thread (prevents Watch re-send loops).
    annotation_last_sent: HashMap<String, Vec<String>>,
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
    /// without one it shows the built-in demo fixture (or awaits Orbit auto-connect).
    #[must_use]
    pub(crate) fn new(
        theme_id: String,
        tokens: Tokens,
        server: Option<crate::live::StartupServer>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Self {
        let mut layout = LayoutState::default();
        let env_pinned_server = crate::live::server_config_from_env().is_some();
        let server_url = server.as_ref().map(|s| s.config.http_base_url.to_string());
        let server_label = server.as_ref().and_then(|s| s.label.clone());
        let initial_orbit_server_id = server.as_ref().and_then(|s| s.orbit_server_id.clone());

        let (shell, connection) = match server {
            Some(startup) => {
                let (connection, events) =
                    Connection::start(startup.config, crate::live::RT.handle());
                connection.subscribe_shell();
                connection.subscribe_panel_requests(Some(default_device_name()));
                Self::pump_events(1, startup.orbit_server_id, events, cx);
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

        let chat =
            cx.new(|cx| crate::chat::ChatView::new(tokens.clone(), connection.clone(), window, cx));
        cx.subscribe_in(
            &chat,
            window,
            |app, _chat, event: &crate::chat::ChatEvent, window, cx| match event {
                crate::chat::ChatEvent::Send { text, attachments } => {
                    app.send_prompt_with_attachments(
                        text.clone(),
                        attachments.clone(),
                        Some(window),
                        cx,
                    );
                }
                crate::chat::ChatEvent::Stop => app.stop_selected(cx),
                crate::chat::ChatEvent::Approval { entry_id, decision } => {
                    app.respond_approval(entry_id, decision, cx);
                }
                crate::chat::ChatEvent::ModelSelected {
                    instance_id,
                    model,
                    options,
                } => {
                    app.select_model(instance_id, model, options.as_ref(), cx);
                }
                crate::chat::ChatEvent::OpenDiff => {
                    app.select_right_panel_tab(RightPanelTab::Diff, cx);
                }
                crate::chat::ChatEvent::OpenFile(path) => {
                    app.select_right_panel_surface(PanelSurface::File(path.clone()), cx);
                }
                crate::chat::ChatEvent::RuntimeModeSelected(mode) => {
                    app.set_runtime_mode(mode, cx);
                }
                crate::chat::ChatEvent::InteractionModeSelected(mode) => {
                    app.set_interaction_mode(mode, cx);
                }
                crate::chat::ChatEvent::WorkspaceModeSelected(use_worktree) => {
                    app.set_draft_workspace_strategy(*use_worktree, cx);
                }
                crate::chat::ChatEvent::DraftProjectSelected(project_id) => {
                    app.set_draft_project(project_id.clone(), cx);
                }
                crate::chat::ChatEvent::StartNewThread => {
                    app.start_new_thread(None, Some(window), cx);
                }
                crate::chat::ChatEvent::OpenConnections => {
                    app.open_settings_page(
                        Some(crate::settings::SettingsPage::Connections),
                        window,
                        cx,
                    );
                }
                crate::chat::ChatEvent::SlashCommand(command) => {
                    app.handle_slash_command(command, cx);
                }
            },
        )
        .detach();
        if let Some(path) = crate::live::theme_file_from_env() {
            Self::watch_theme_file(path, cx);
        }
        let right_panel = cx.new(|cx| {
            let mut panel =
                crate::panels::RightPanel::new(tokens.clone(), connection.clone(), window, cx);
            panel.set_embedded(true, cx);
            panel
        });
        cx.subscribe(
            &right_panel,
            |app, _, event: &crate::panels::RightPanelEvent, cx| match event {
                crate::panels::RightPanelEvent::OpenFile(path) => {
                    app.select_right_panel_surface(PanelSurface::File(path.clone()), cx);
                }
                crate::panels::RightPanelEvent::OpenTab(tab) => {
                    app.select_right_panel_tab(*tab, cx);
                }
                crate::panels::RightPanelEvent::SendPrompt(prompt) => {
                    app.send_prompt(prompt.clone(), cx);
                }
                crate::panels::RightPanelEvent::Annotation(action) => {
                    app.handle_annotation_action(action.clone(), cx);
                }
            },
        )
        .detach();

        let sidebar_search_input = cx.new(|cx| {
            gpui_kit::component::input::InputState::new(window, cx).placeholder("Search")
        });
        let sidebar_search_sub = cx.subscribe(
            &sidebar_search_input,
            |_app, _, event: &gpui_kit::component::input::InputEvent, cx| {
                if matches!(event, gpui_kit::component::input::InputEvent::Change) {
                    cx.notify();
                }
            },
        );
        let rename_input = cx.new(|cx| {
            gpui_kit::component::input::InputState::new(window, cx).placeholder("Thread title")
        });
        let rename_sub = cx.subscribe(
            &rename_input,
            |app, _, event: &gpui_kit::component::input::InputEvent, cx| match event {
                gpui_kit::component::input::InputEvent::PressEnter { .. } => {
                    app.commit_thread_rename(cx);
                }
                gpui_kit::component::input::InputEvent::Blur => {
                    app.cancel_thread_rename(cx);
                }
                _ => {}
            },
        );

        let orbit = crate::orbit_sync::OrbitSyncState {
            active_server_id: initial_orbit_server_id,
            ..Default::default()
        };
        let mut app = Self {
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
            env_pinned_server,
            threads: HashMap::new(),
            chat,
            right_panel,
            ended_threads: HashSet::new(),
            draft: None,
            right_panel_open_tabs: vec![PanelSurface::Kind(RightPanelTab::Files)],
            right_panel_file: None,
            right_panel_add_menu_open: false,
            right_panel_maximized: false,
            seam_drag: None,
            command_palette: None,
            settings_modal: None,
            overlay_subscriptions: Vec::new(),
            focus_before_overlay: None,
            sidebar_search_input,
            _sidebar_search_sub: sidebar_search_sub,
            renaming_thread_id: None,
            rename_input,
            _rename_sub: rename_sub,
            sidebar_filter_menu_open: false,
            reduce_transparency: false,
            server_url,
            server_label,
            connection_gen: 1,
            orbit,
            pending_open_thread: None,
            _control_server: None,
            _activation_task: None,
            subscribed_thread_id: None,
            subscribed_annotation_project: None,
            annotations: Vec::new(),
            annotation_watching_threads: HashSet::new(),
            annotation_last_sent: HashMap::new(),
        };
        app.sync_chat(cx);
        if crate::orbit_sync::orbit_sync_enabled_by_env() {
            app.sync_orbit_profile(crate::orbit_sync::allow_startup_theme_adopt(), cx);
            if let Some(rx) = app.right_panel.read(cx).subscribe_orbit_events(cx) {
                Self::pump_orbit_realtime(rx, cx);
            }
        }
        app
    }

    /// Opens (or closes) the `Cmd+K` command palette.
    pub(crate) fn open_command_palette(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        use crate::palette::{CommandPalette, PaletteAction, PaletteEvent, PaletteItems};
        if self.command_palette.take().is_some() {
            self.restore_focus(window, cx);
            self.sync_browser_visibility(cx);
            cx.notify();
            return;
        }
        self.remember_focus(window, cx);
        let active_server_id = self.orbit.active_server_id.clone().or_else(|| {
            self.server_url
                .as_deref()
                .and_then(|url| self.orbit.fleet.find_by_url(url))
                .map(|t| t.server_id.clone())
        });
        let items = PaletteItems::from_shell(
            &self.shell,
            self.layout.selected_thread_id.as_deref(),
            &self.theme_id,
            &self.orbit.custom_themes,
            &self.orbit.fleet,
            active_server_id.as_deref(),
        );
        let tokens = self.tokens.clone();
        let palette = cx.new(|cx| CommandPalette::new(items, tokens, window, cx));
        let sub = cx.subscribe_in(
            &palette,
            window,
            |app, _entity, event: &PaletteEvent, window, cx| {
                app.command_palette = None;
                app.restore_focus(window, cx);
                match event {
                    PaletteEvent::SelectThread(id) => app.select_thread(id.clone(), cx),
                    PaletteEvent::ConnectOrbitTarget(server_id) => {
                        app.connect_orbit_target(server_id.clone(), cx);
                    }
                    PaletteEvent::ApplyTheme(id) => {
                        app.set_theme(id, cx);
                    }
                    PaletteEvent::Action(PaletteAction::NewThread) => {
                        app.start_new_thread(None, Some(window), cx);
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
                app.sync_browser_visibility(cx);
            },
        );
        self.overlay_subscriptions.push(sub);
        self.command_palette = Some(palette);
        self.sync_browser_visibility(cx);
        cx.notify();
    }

    /// Notes what has the keyboard before an overlay takes it.
    fn remember_focus(&mut self, window: &Window, cx: &App) {
        self.focus_before_overlay = window.focused(cx);
    }

    /// Gives the keyboard back after an overlay closes: to what had it before, or to the shell
    /// root. Without this nothing keeps focus, and the app's shortcuts (Cmd+K, Cmd+N) stop
    /// working until a click.
    fn restore_focus(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let handle = self
            .focus_before_overlay
            .take()
            .unwrap_or_else(|| self.focus_handle.clone());
        window.focus(&handle, cx);
    }

    /// Opens (or closes) the Settings route modal.
    pub(crate) fn open_settings(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        self.open_settings_page(None, window, cx);
    }

    /// Opens the Settings route modal, optionally landing directly on `page` (or closing it when
    /// toggled with `page == None`).
    pub(crate) fn open_settings_page(
        &mut self,
        page: Option<crate::settings::SettingsPage>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        use crate::settings::{SettingsConnectionInfo, SettingsEvent, SettingsModal};
        if let Some(existing) = &self.settings_modal {
            if let Some(target_page) = page {
                existing.update(cx, |m, cx| m.select_page(target_page, cx));
                return;
            }
            self.settings_modal = None;
            self.restore_focus(window, cx);
            self.sync_browser_visibility(cx);
            cx.notify();
            return;
        }
        self.remember_focus(window, cx);
        let connection = SettingsConnectionInfo {
            server_label: self.server_label.clone(),
            server_url: self.server_url.clone(),
            status: self.status.clone(),
        };
        let orbit_info = self.orbit.settings_info(self.server_url.as_deref());
        let custom_themes = self.orbit.custom_themes.clone();
        let theme_id = self.theme_id.clone();
        let tokens = self.tokens.clone();
        let reduce_transparency = self.reduce_transparency;
        let live_connection = self.connection.clone();
        let projects = self.scheduled_task_projects();
        let default_model = self.default_scheduled_task_model();
        let modal = cx.new(|cx| {
            let mut m = SettingsModal::new(
                theme_id,
                tokens,
                reduce_transparency,
                connection,
                live_connection,
                projects,
                default_model,
                orbit_info,
                &custom_themes,
                window,
                cx,
            );
            if let Some(target_page) = page {
                m.select_page(target_page, cx);
            }
            m
        });
        let sub = cx.subscribe_in(
            &modal,
            window,
            |app, _entity, event: &SettingsEvent, window, cx| match event {
                SettingsEvent::ApplyTheme(id) => {
                    // set_theme pushes the new tokens into the open modal too.
                    app.set_theme(id, cx);
                }
                SettingsEvent::ReduceTransparency(enabled) => {
                    app.set_reduce_transparency(*enabled, cx);
                }
                SettingsEvent::OrbitSyncNow => {
                    app.sync_orbit_profile(true, cx);
                }
                SettingsEvent::OrbitBindProfile(profile_id) => {
                    app.bind_orbit_profile(*profile_id, cx);
                }
                SettingsEvent::OrbitCreateProfile(name) => {
                    app.create_orbit_profile(name.clone(), cx);
                }
                SettingsEvent::OrbitForcePush => {
                    app.force_push_orbit_profile(cx);
                }
                SettingsEvent::OrbitForcePull => {
                    app.force_pull_orbit_profile(cx);
                }
                SettingsEvent::OrbitRestoreBackup => {
                    app.restore_orbit_backup(cx);
                }
                SettingsEvent::OrbitConnectTarget(server_id) => {
                    app.connect_orbit_target(server_id.clone(), cx);
                }
                SettingsEvent::OrbitWakeInstance {
                    instance_id,
                    server_id,
                } => {
                    app.wake_orbit_instance(*instance_id, server_id.clone(), cx);
                }
                SettingsEvent::OrbitToggleSyncWorkspaces(enabled) => {
                    app.orbit.snapshot.prefs.sync_workspaces = *enabled;
                    app.orbit.persist_snapshot();
                    if *enabled {
                        app.sync_orbit_profile(false, cx);
                    }
                }
                SettingsEvent::OrbitToggleSyncAppearance(enabled) => {
                    app.orbit.snapshot.prefs.sync_appearance = *enabled;
                    app.orbit.persist_snapshot();
                    if *enabled {
                        app.sync_orbit_profile(true, cx);
                    }
                }
                SettingsEvent::OrbitToggleSyncDesktopSettings(enabled) => {
                    app.orbit.snapshot.prefs.sync_desktop_settings = *enabled;
                    app.orbit.persist_snapshot();
                    if *enabled {
                        app.sync_orbit_profile(false, cx);
                    }
                }
                SettingsEvent::ConnectDirectServer {
                    raw_url,
                    bearer_token,
                } => {
                    app.connect_direct_server(raw_url.clone(), bearer_token.clone(), cx);
                }
                SettingsEvent::Close => {
                    app.settings_modal = None;
                    app.restore_focus(window, cx);
                    app.sync_browser_visibility(cx);
                    cx.notify();
                }
            },
        );
        self.overlay_subscriptions.push(sub);
        self.settings_modal = Some(modal);
        self.sync_browser_visibility(cx);
        cx.notify();
    }

    /// A full-height seam with a 7px drag handle over it (Conn's resizable sidebar and right
    /// panel). Double-click resets the panel to its default width.
    fn render_seam(&self, right_panel: bool, cx: &mut Context<'_, Self>) -> impl IntoElement {
        use gpui_kit::{CursorStyle, MouseButton, MouseDownEvent};
        let handle = div()
            .id(if right_panel {
                "seam-right-panel"
            } else {
                "seam-sidebar"
            })
            .absolute()
            .top_0()
            .bottom_0()
            .left(px(-3.0))
            .w(px(7.0))
            .cursor(CursorStyle::ResizeLeftRight)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |app, event: &MouseDownEvent, _, cx| {
                    cx.stop_propagation();
                    let x = f32::from(event.position.x);
                    if event.click_count >= 2 {
                        if right_panel {
                            app.layout
                                .set_right_panel_width(conn_state::RIGHT_PANEL_DEFAULT_WIDTH);
                        } else {
                            app.layout
                                .set_sidebar_width(conn_state::SIDEBAR_DEFAULT_WIDTH);
                        }
                        app.seam_drag = None;
                    } else if right_panel {
                        app.seam_drag = Some(SeamDrag::RightPanel {
                            from_x: x,
                            start: app.layout.right_panel_width,
                        });
                    } else {
                        app.seam_drag = Some(SeamDrag::Sidebar {
                            from_x: x,
                            start: app.layout.sidebar_width,
                        });
                    }
                    cx.notify();
                }),
            );
        div()
            .relative()
            .h_full()
            .flex_shrink_0()
            .child(two_tone_divider(&self.tokens, &self.geometry))
            .child(handle)
    }

    /// Tells the right panel whether its surfaces are on screen, so the native browser view
    /// hides while the panel is closed or a GPUI overlay covers it.
    fn sync_browser_visibility(&self, cx: &mut Context<'_, Self>) {
        let visible = self.layout.right_panel_open
            && self.command_palette.is_none()
            && self.settings_modal.is_none();
        self.right_panel
            .update(cx, |panel, cx| panel.set_surface_visible(visible, cx));
    }

    /// Pushes the selected thread's timeline (or active draft state) into the chat view and right panel.
    fn sync_chat(&mut self, cx: &mut Context<'_, Self>) {
        let selected = self.layout.selected_thread_id.as_deref();
        let shell_thread = selected.and_then(|id| self.shell.find_thread(id));
        let draft_view = self.draft.as_ref().map(|draft| {
            let project = self.shell.project(&draft.project_id);
            let projects = self
                .shell
                .projects
                .iter()
                .filter(|p| p.archived_at.is_none())
                .map(|p| crate::chat::DraftProjectOption {
                    id: p.id.clone(),
                    title: p.title.clone(),
                    workspace_root: p.workspace_root.clone(),
                })
                .collect();
            crate::chat::DraftViewInfo {
                project_id: draft.project_id.clone(),
                project_title: project
                    .map(|p| p.title.clone())
                    .unwrap_or_else(|| draft.project_id.clone()),
                workspace_root: project
                    .map(|p| p.workspace_root.clone())
                    .unwrap_or_default(),
                projects,
                launching: draft.launching,
            }
        });
        let title = if self.draft.is_some() {
            Some("New thread".to_owned())
        } else {
            shell_thread.map(|t| t.title.clone())
        };
        let root = shell_thread
            .and_then(|t| {
                t.worktree_path.clone().or_else(|| {
                    self.shell
                        .project(&t.project_id)
                        .map(|p| p.workspace_root.clone())
                })
            })
            .or_else(|| {
                self.draft
                    .as_ref()
                    .and_then(|d| self.shell.project(&d.project_id))
                    .map(|p| p.workspace_root.clone())
            });
        let timeline = selected.and_then(|id| self.threads.get(id));
        let fallback = selected.map(conn_state::ThreadState::new);
        let thread = timeline.or(fallback.as_ref());
        let project_id = shell_thread
            .map(|t| t.project_id.clone())
            .or_else(|| self.draft.as_ref().map(|d| d.project_id.clone()));
        let thread_id = selected.map(str::to_owned);
        let surface = self.right_panel_surface();
        let panel_root = root.clone();
        self.right_panel.update(cx, |panel, cx| {
            panel.set_context(project_id.clone(), panel_root, thread_id, cx);
            panel.set_surface(&surface, cx);
        });
        let (
            model_instance,
            model,
            model_options,
            branch,
            worktree_active,
            runtime_mode,
            interaction_mode,
        ) = if let Some(draft) = &self.draft {
            (
                draft.model_instance_id.clone(),
                draft.model_slug.clone(),
                draft.model_options.clone(),
                None,
                draft.use_worktree,
                draft.runtime_mode.clone(),
                draft.interaction_mode.clone(),
            )
        } else {
            let model =
                shell_thread.and_then(|t| t.model_selection.model.as_str().map(str::to_owned));
            let model_instance = shell_thread.map(|t| t.provider_instance_id.clone());
            let model_options = shell_thread
                .map(|t| conn_contract::to_json(&t.model_selection))
                .and_then(|v| {
                    v.get("options")
                        .and_then(serde_json::Value::as_object)
                        .cloned()
                });
            let branch = shell_thread.and_then(|t| t.branch.clone());
            let worktree_active = shell_thread.is_some_and(|t| t.worktree_path.is_some());
            let runtime_mode = shell_thread
                .map(|t| conn_contract::to_json(&t.runtime_mode))
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_else(|| "full-access".to_owned());
            let interaction_mode = shell_thread
                .map(|t| conn_contract::to_json(&t.interaction_mode))
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_else(|| "default".to_owned());
            (
                model_instance,
                model,
                model_options,
                branch,
                worktree_active,
                runtime_mode,
                interaction_mode,
            )
        };
        let has_projects = self.shell.projects.iter().any(|p| p.archived_at.is_none());
        let connected = self.connection.is_some();
        self.chat.update(cx, |chat, cx| {
            chat.set_shell_availability(has_projects, connected, cx);
            chat.set_draft(draft_view, cx);
            chat.set_workspace_root(root, cx);
            chat.set_thread(thread, title, cx);
            chat.set_thread_context(branch, worktree_active, runtime_mode, interaction_mode, cx);
            if let Some(model) = model {
                chat.set_model_selection(model_instance, model, model_options, cx);
            }
        });
        self.sync_annotations_state(project_id.as_deref(), cx);
    }

    /// Moves connection events onto the GPUI thread, one batch per wake.
    fn pump_events(
        generation: u64,
        orbit_server_id: Option<String>,
        mut events: tokio::sync::mpsc::Receiver<ClientEvent>,
        cx: &mut Context<'_, Self>,
    ) {
        cx.spawn(async move |this, cx| {
            while let Some(first) = events.recv().await {
                let mut batch = vec![first];
                while let Ok(more) = events.try_recv() {
                    batch.push(more);
                }
                let keep_going = this
                    .update(cx, |app, cx| {
                        if app.connection_gen != generation {
                            return false;
                        }
                        let mut status_changed = false;
                        for event in batch {
                            if matches!(
                                event,
                                ClientEvent::Status(_) | ClientEvent::BearerIssued(_)
                            ) {
                                status_changed = true;
                            }
                            app.apply_event(event, orbit_server_id.as_deref(), cx);
                        }
                        if status_changed {
                            app.refresh_settings_orbit_info(cx);
                        }
                        app.sync_chat(cx);
                        cx.notify();
                        true
                    })
                    .unwrap_or(false);
                if !keep_going {
                    break;
                }
            }
        })
        .detach();
    }

    fn apply_event(
        &mut self,
        event: ClientEvent,
        orbit_server_id: Option<&str>,
        cx: &mut Context<'_, Self>,
    ) {
        match event {
            ClientEvent::Status(status) => {
                if let ConnectionStatus::Failed(ref msg) = status
                    && let Some(sid) = orbit_server_id
                    && (msg.contains("401")
                        || msg.to_ascii_lowercase().contains("auth")
                        || msg.to_ascii_lowercase().contains("unauthorized"))
                {
                    self.orbit.sessions.remove_bearer(sid);
                    self.orbit.persist_sessions();
                }
                if matches!(status, ConnectionStatus::Connected) {
                    self.orbit.connecting_server_id = None;
                    self.chat.update(cx, |chat, cx| chat.refresh_providers(cx));
                }
                self.status = Some(status);
            }
            ClientEvent::BearerIssued(token) => {
                if let Some(sid) = orbit_server_id {
                    let url = self.server_url.clone().unwrap_or_default();
                    let label = self.server_label.clone().unwrap_or_else(|| sid.to_owned());
                    self.orbit.sessions.record_bearer(sid, url, label, token);
                    self.orbit.persist_sessions();
                } else if !self.env_pinned_server
                    && let Some(url) = self.server_url.clone()
                {
                    let saved = conn_desktop::server_store::SavedServerConfig::new(
                        url,
                        self.server_label.clone(),
                        token,
                    );
                    if let Err(err) = saved.save_default() {
                        eprintln!("server store: failed to persist bearer: {err}");
                    }
                }
            }
            ClientEvent::Shell(item) => {
                let change = self.shell.apply(item);
                if !change.threads_changed.is_empty() {
                    self.resubscribe_ended_threads();
                }
                if change.snapshot_required
                    && let Some(connection) = &self.connection
                {
                    connection.subscribe_shell();
                }
                if let Some(pending_id) = self.pending_open_thread.clone()
                    && self.shell.find_thread(&pending_id).is_some()
                {
                    self.pending_open_thread = None;
                    self.select_thread(pending_id, cx);
                } else if self.layout.selected_thread_id.is_none() && self.draft.is_none() {
                    let initial = self
                        .shell
                        .top_level_active_threads()
                        .next()
                        .or_else(|| self.shell.threads.first())
                        .map(|first| (first.project_id.clone(), first.id.clone()));
                    if let Some((project_id, thread_id)) = initial {
                        self.layout.selected_project_id = Some(project_id);
                        self.open_thread(thread_id);
                    }
                }
            }
            ClientEvent::Thread { thread_id, item } => {
                self.threads
                    .entry(thread_id.clone())
                    .or_insert_with(|| ThreadState::new(thread_id))
                    .apply(item);
            }
            ClientEvent::PanelRequest(request) => {
                self.dispatch_agent_panel_request(request, cx);
            }
            ClientEvent::Annotations {
                project_id,
                annotations,
            } => {
                if self.subscribed_annotation_project.as_deref() == Some(project_id.as_str()) {
                    self.annotations = annotations;
                }
            }
            ClientEvent::StreamEnded { tag, key, error } => {
                if tag == "orchestration.subscribeThread" && self.threads.contains_key(&key) {
                    if let Some(error) = error {
                        eprintln!("thread stream {key} ended: {error}");
                    }
                    self.ended_threads.insert(key);
                    self.resubscribe_ended_threads();
                }
            }
        }
    }

    /// Resubscribes ended thread streams whose thread the shell now lists.
    fn resubscribe_ended_threads(&mut self) {
        let Some(connection) = &self.connection else {
            return;
        };
        let ready: Vec<String> = self
            .ended_threads
            .iter()
            .filter(|id| self.shell.find_thread(id).is_some())
            .cloned()
            .collect();
        for id in ready {
            self.ended_threads.remove(&id);
            connection.subscribe_thread(&id);
        }
    }

    /// Selects `thread_id` and subscribes to its timeline once.
    fn open_thread(&mut self, thread_id: String) {
        self.draft = None;
        if let Some(connection) = &self.connection
            && self.subscribed_thread_id.as_deref() != Some(thread_id.as_str())
        {
            if let Some(prev) = self.subscribed_thread_id.take() {
                connection.unsubscribe_thread(&prev);
            }
            self.threads
                .entry(thread_id.clone())
                .or_insert_with(|| ThreadState::new(thread_id.clone()));
            connection.subscribe_thread(&thread_id);
            self.subscribed_thread_id = Some(thread_id.clone());
        }
        self.layout.selected_thread_id = Some(thread_id);
    }

    /// Picks the default project id for a new thread, honoring explicit selection, the active
    /// workspace filter (Orbit workspace or project id), currently selected project, or first
    /// non-archived project.
    fn resolve_new_thread_project(&self, requested: Option<String>) -> Option<String> {
        if let Some(id) = requested
            && self.shell.project(&id).is_some()
        {
            return Some(id);
        }
        if let Some(ws_id) = self.active_workspace.as_deref() {
            if let Some(orbit_ws) = self.orbit.workspaces.iter().find(|w| w.id == ws_id) {
                if let Some(sel) = self
                    .layout
                    .selected_project_id
                    .as_deref()
                    .and_then(|id| self.shell.project(id))
                    && conn_desktop::orbit::workspace_matches_project(
                        orbit_ws,
                        &sel.id,
                        &sel.title,
                        &sel.workspace_root,
                    )
                {
                    return Some(sel.id.clone());
                }
                if let Some(matched) = self.shell.projects.iter().find(|p| {
                    p.archived_at.is_none()
                        && conn_desktop::orbit::workspace_matches_project(
                            orbit_ws,
                            &p.id,
                            &p.title,
                            &p.workspace_root,
                        )
                }) {
                    return Some(matched.id.clone());
                }
            } else if self.shell.project(ws_id).is_some() {
                return Some(ws_id.to_owned());
            }
        }
        self.layout
            .selected_project_id
            .clone()
            .filter(|id| self.shell.project(id).is_some())
            .or_else(|| {
                self.shell
                    .projects
                    .iter()
                    .find(|p| p.archived_at.is_none())
                    .or_else(|| self.shell.projects.first())
                    .map(|p| p.id.clone())
            })
    }

    /// Sets the runtime mode (`approval-required`, `full-access`, ...) for the active draft.
    #[cfg(feature = "automation")]
    pub(crate) fn set_draft_runtime_mode(
        &mut self,
        mode: Option<String>,
        cx: &mut Context<'_, Self>,
    ) {
        if let (Some(draft), Some(mode)) = (&mut self.draft, mode) {
            draft.runtime_mode = mode;
            self.sync_chat(cx);
            cx.notify();
        }
    }

    /// Starts a new thread draft in `project_id` (or the active workspace/project). The
    /// composer's first send launches it via `orchestration.launchThread`.
    pub(crate) fn start_new_thread(
        &mut self,
        project_id: Option<String>,
        window: Option<&mut Window>,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(project_id) = self.resolve_new_thread_project(project_id) else {
            if let Some(window) = window {
                self.add_project_via_picker(window, cx);
            }
            return;
        };
        let template = self.shell.threads_for_project(&project_id).next();
        let project_model = self
            .shell
            .project(&project_id)
            .and_then(|p| p.default_model_selection.as_ref())
            .or_else(|| template.map(|t| &t.model_selection));
        let (model_instance_id, model_slug, model_options) = if let Some(sel) = project_model {
            let val = conn_contract::to_json(sel);
            let instance = val
                .get("instanceId")
                .or_else(|| val.get("provider"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
                .or_else(|| template.map(|t| t.provider_instance_id.clone()));
            let slug = val
                .get("model")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            let opts = val
                .get("options")
                .and_then(serde_json::Value::as_object)
                .cloned();
            (instance, slug, opts)
        } else if let Some((inst, slug, opts)) = self.chat.read(cx).current_model_selection(cx) {
            (Some(inst), Some(slug), opts)
        } else {
            (None, None, None)
        };
        let runtime_mode = template
            .map(|t| conn_contract::to_json(&t.runtime_mode))
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_else(|| "full-access".to_owned());
        let interaction_mode = template
            .map(|t| conn_contract::to_json(&t.interaction_mode))
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_else(|| "default".to_owned());

        if let Some(connection) = &self.connection
            && let Some(prev) = self.subscribed_thread_id.take()
        {
            connection.unsubscribe_thread(&prev);
        }
        self.layout.selected_project_id = Some(project_id.clone());
        self.layout.selected_thread_id = None;
        self.draft = Some(DraftThreadState {
            project_id,
            model_instance_id,
            model_slug,
            model_options,
            runtime_mode,
            interaction_mode,
            use_worktree: false,
            launching: false,
        });
        self.chat.update(cx, |chat, cx| chat.set_error(None, cx));
        self.sync_chat(cx);
        if let Some(window) = window {
            self.chat
                .update(cx, |chat, cx| chat.focus_composer(window, cx));
        }
        cx.notify();
    }

    /// Discards the active new-thread draft and falls back to the most recent active thread.
    pub(crate) fn cancel_new_thread(&mut self, cx: &mut Context<'_, Self>) {
        if self.draft.take().is_none() {
            return;
        }
        self.chat.update(cx, |chat, cx| chat.set_error(None, cx));
        let initial = self
            .shell
            .top_level_active_threads()
            .next()
            .or_else(|| self.shell.threads.first())
            .map(|first| (first.project_id.clone(), first.id.clone()));
        if let Some((project_id, thread_id)) = initial {
            self.layout.selected_project_id = Some(project_id);
            self.open_thread(thread_id);
        }
        self.sync_chat(cx);
        cx.notify();
    }

    /// Changes the target project of the active new-thread draft.
    pub(crate) fn set_draft_project(&mut self, project_id: String, cx: &mut Context<'_, Self>) {
        let Some(draft) = &mut self.draft else {
            return;
        };
        if draft.launching || draft.project_id == project_id {
            return;
        }
        draft.project_id = project_id.clone();
        self.layout.selected_project_id = Some(project_id);
        self.sync_chat(cx);
        cx.notify();
    }

    /// Toggles whether the active new-thread draft launches in a fresh git worktree or local root.
    pub(crate) fn set_draft_workspace_strategy(
        &mut self,
        use_worktree: bool,
        cx: &mut Context<'_, Self>,
    ) {
        if let Some(draft) = &mut self.draft
            && !draft.launching
        {
            draft.use_worktree = use_worktree;
            self.sync_chat(cx);
            cx.notify();
        }
    }

    /// Launches the draft thread with `text` and `attachments` as its first message.
    fn launch_draft(
        &mut self,
        text: String,
        attachments: Vec<conn_contract::ChatAttachment>,
        window: Option<&mut Window>,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(connection) = self.connection.clone() else {
            self.chat.update(cx, |chat, cx| {
                chat.set_error(
                    Some(
                        "Not connected to a conn-server. Open Settings → Connections to connect."
                            .to_owned(),
                    ),
                    cx,
                );
            });
            if let Some(window) = window {
                self.chat
                    .update(cx, |chat, cx| chat.set_draft_text(text, window, cx));
            }
            return;
        };
        let Some(draft) = self.draft.clone() else {
            return;
        };
        if draft.launching {
            return;
        }
        let project_id = draft.project_id.clone();

        // Resolve model selection: explicit draft selection -> live composer catalog -> project
        // default -> latest thread in project -> any thread on server.
        let model_json = if let (Some(inst), Some(slug)) = (
            draft.model_instance_id.as_deref(),
            draft.model_slug.as_deref(),
        ) {
            let mut obj = serde_json::Map::new();
            obj.insert("instanceId".to_owned(), serde_json::json!(inst));
            obj.insert("model".to_owned(), serde_json::json!(slug));
            if let Some(opts) = &draft.model_options
                && !opts.is_empty()
            {
                obj.insert(
                    "options".to_owned(),
                    serde_json::Value::Object(opts.clone()),
                );
            }
            Some(serde_json::Value::Object(obj))
        } else if let Some((inst, slug, opts)) = self.chat.read(cx).current_model_selection(cx) {
            let mut obj = serde_json::Map::new();
            obj.insert("instanceId".to_owned(), serde_json::json!(inst));
            obj.insert("model".to_owned(), serde_json::json!(slug));
            if let Some(opts) = opts
                && !opts.is_empty()
            {
                obj.insert("options".to_owned(), serde_json::Value::Object(opts));
            }
            Some(serde_json::Value::Object(obj))
        } else {
            self.shell
                .project(&project_id)
                .and_then(|p| p.default_model_selection.clone())
                .or_else(|| {
                    self.shell
                        .threads_for_project(&project_id)
                        .next()
                        .map(|t| t.model_selection.clone())
                })
                .or_else(|| {
                    self.shell
                        .threads
                        .first()
                        .map(|t| t.model_selection.clone())
                })
                .map(|m| conn_contract::to_json(&m))
        };

        let Some(model_json) = model_json else {
            self.chat.update(cx, |chat, cx| {
                chat.set_error(
                    Some("Pick a model in the composer before creating a thread.".to_owned()),
                    cx,
                );
            });
            if let Some(window) = window {
                self.chat
                    .update(cx, |chat, cx| chat.set_draft_text(text, window, cx));
            }
            return;
        };

        let strategy = if draft.use_worktree {
            crate::commands::WorkspaceStrategyChoice::Worktree
        } else {
            crate::commands::WorkspaceStrategyChoice::Local
        };
        let thread_id = crate::commands::new_thread_id();
        let payload = crate::commands::launch_thread_payload(
            &thread_id,
            &project_id,
            &text,
            &attachments,
            model_json,
            &draft.runtime_mode,
            &draft.interaction_mode,
            strategy,
        );

        if let Some(active_draft) = &mut self.draft {
            active_draft.launching = true;
        }
        self.chat.update(cx, |chat, cx| chat.set_error(None, cx));
        self.sync_chat(cx);
        cx.notify();

        let generation = self.connection_gen;
        let fallback_text = text;
        let launch_window = window.map(|w| w.window_handle());
        cx.spawn(async move |this, cx| {
            let result = connection
                .call_json("orchestration.launchThread", payload)
                .await;
            let _ = this.update(cx, |app, cx| {
                if app.connection_gen != generation {
                    return;
                }
                match result {
                    Ok(value) => {
                        let parsed = conn_contract::from_json::<
                            conn_contract::OrchestrationV2ThreadLaunchResult,
                        >(value.clone());
                        let final_thread_id = match &parsed {
                            Ok(res) => res.thread_id.clone(),
                            Err(_) => value
                                .get("threadId")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or(&thread_id)
                                .to_owned(),
                        };
                        if let Ok(res) = parsed {
                            let mut state = ThreadState::new(final_thread_id.clone());
                            state.apply_projection(res.projection, res.sequence);
                            app.threads.insert(final_thread_id.clone(), state);
                        }
                        app.draft = None;
                        app.layout.selected_project_id = Some(project_id.clone());
                        app.layout.selected_thread_id = Some(final_thread_id.clone());
                        app.ended_threads.remove(&final_thread_id);
                        connection.subscribe_thread(&final_thread_id);
                        app.chat.update(cx, |chat, cx| chat.set_error(None, cx));
                        app.sync_chat(cx);
                        cx.notify();
                    }
                    Err(err) => {
                        let msg = crate::commands::format_client_error(&err);
                        eprintln!("new thread: launchThread failed: {msg}");
                        if let Some(active_draft) = &mut app.draft {
                            active_draft.launching = false;
                        }
                        app.chat.update(cx, |chat, cx| {
                            chat.set_error(Some(format!("Could not create thread: {msg}")), cx);
                        });
                        if let Some(win) = launch_window {
                            let chat = app.chat.clone();
                            let restore = fallback_text.clone();
                            let _ = win.update(cx, |_, window, cx| {
                                chat.update(cx, |c, cx| c.set_draft_text(restore, window, cx));
                            });
                        }
                        app.sync_chat(cx);
                        cx.notify();
                    }
                }
            });
        })
        .detach();
    }

    /// Sends `text` (without attachments) to the selected thread (or launches the active draft).
    pub(crate) fn send_prompt(&mut self, text: String, cx: &mut Context<'_, Self>) {
        self.send_prompt_with_attachments(text, Vec::new(), None, cx);
    }

    /// Sends `text` and `attachments` to the selected thread over `orchestration.dispatchCommand`,
    /// or launches the active new-thread draft via `orchestration.launchThread`.
    pub(crate) fn send_prompt_with_attachments(
        &mut self,
        text: String,
        attachments: Vec<conn_contract::ChatAttachment>,
        window: Option<&mut Window>,
        cx: &mut Context<'_, Self>,
    ) {
        if self.draft.is_some() {
            self.launch_draft(text, attachments, window, cx);
            return;
        }
        let (Some(connection), Some(thread_id)) = (
            self.connection.clone(),
            self.layout.selected_thread_id.clone(),
        ) else {
            return;
        };
        let working = self.threads.get(&thread_id).is_some_and(|t| t.working);
        let command = match crate::commands::send_message(&thread_id, &text, &attachments, working)
        {
            Ok(command) => command,
            Err(e) => {
                eprintln!("send: could not build message.dispatch: {e}");
                self.chat.update(cx, |chat, cx| {
                    chat.set_error(Some(format!("Could not build message: {e}")), cx);
                });
                return;
            }
        };
        self.chat.update(cx, |chat, cx| chat.set_error(None, cx));
        let generation = self.connection_gen;
        let send_window = window.map(|w| w.window_handle());
        let fallback_text = text;
        cx.spawn(async move |this, cx| {
            if let Err(err) = connection.dispatch_command(command).await {
                let msg = crate::commands::format_client_error(&err);
                eprintln!("send: dispatchCommand failed: {msg}");
                let _ = this.update(cx, |app, cx| {
                    if app.connection_gen != generation {
                        return;
                    }
                    app.chat.update(cx, |chat, cx| {
                        chat.set_error(Some(format!("Send failed: {msg}")), cx);
                    });
                    if let Some(win) = send_window {
                        let chat = app.chat.clone();
                        let restore = fallback_text.clone();
                        let _ = win.update(cx, |_, window, cx| {
                            chat.update(cx, |c, cx| c.set_draft_text(restore, window, cx));
                        });
                    }
                    cx.notify();
                });
            }
        })
        .detach();
    }

    /// Answers the approval timeline entry `entry_id` of the selected thread.
    pub(crate) fn respond_approval(
        &mut self,
        entry_id: &str,
        decision: &str,
        cx: &mut Context<'_, Self>,
    ) {
        let (Some(connection), Some(thread_id)) = (
            self.connection.clone(),
            self.layout.selected_thread_id.clone(),
        ) else {
            return;
        };
        let Some(request_id) = self
            .threads
            .get(&thread_id)
            .and_then(|t| t.approval_requests.get(entry_id))
            .cloned()
        else {
            eprintln!("approval: no request id for entry {entry_id}");
            return;
        };
        let command = match crate::commands::respond_approval(&thread_id, &request_id, decision) {
            Ok(command) => command,
            Err(e) => {
                eprintln!("approval: could not build runtime-request.respond: {e}");
                return;
            }
        };
        cx.spawn(async move |_, _| {
            if let Err(e) = connection.dispatch_command(command).await {
                eprintln!("approval: dispatchCommand failed: {e}");
            }
        })
        .detach();
    }

    /// Switches the selected thread's (or active draft's) model and optional effort/provider
    /// options (`thread.model-selection.set`).
    pub(crate) fn select_model(
        &mut self,
        instance_id: &str,
        model: &str,
        options: Option<&serde_json::Map<String, serde_json::Value>>,
        cx: &mut Context<'_, Self>,
    ) {
        if let Some(draft) = &mut self.draft {
            draft.model_instance_id = Some(instance_id.to_owned());
            draft.model_slug = Some(model.to_owned());
            draft.model_options = options.cloned();
            self.sync_chat(cx);
            cx.notify();
            return;
        }
        let (Some(connection), Some(thread_id)) = (
            self.connection.clone(),
            self.layout.selected_thread_id.clone(),
        ) else {
            return;
        };
        let command =
            match crate::commands::set_model_selection(&thread_id, instance_id, model, options) {
                Ok(command) => command,
                Err(e) => {
                    eprintln!("model: could not build thread.model-selection.set: {e}");
                    return;
                }
            };
        cx.spawn(async move |_, _| {
            if let Err(e) = connection.dispatch_command(command).await {
                eprintln!("model: dispatchCommand failed: {e}");
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

    /// Opens the Browser tab and loads `url`.
    #[cfg(feature = "automation")]
    pub(crate) fn browse(&mut self, url: String, cx: &mut Context<'_, Self>) {
        self.select_right_panel_tab(RightPanelTab::Browser, cx);
        self.right_panel
            .update(cx, |panel, cx| panel.navigate_browser(url, cx));
    }

    /// Diagnostic state of the Browser tab.
    #[cfg(feature = "automation")]
    pub(crate) fn browser_state(&self, cx: &App) -> serde_json::Value {
        self.right_panel.read(cx).browser_state(cx)
    }

    /// The Browser tab's page title.
    #[cfg(feature = "automation")]
    pub(crate) fn browser_title(&self, cx: &App) -> String {
        self.right_panel.read(cx).browser_title(cx)
    }

    #[cfg(all(feature = "cef", feature = "automation"))]
    pub(crate) fn browser_preview_eval(
        &mut self,
        expression: &str,
        cx: &mut Context<'_, Self>,
    ) -> Result<tokio::sync::oneshot::Receiver<Result<serde_json::Value, String>>, String> {
        self.right_panel
            .update(cx, |panel, cx| panel.browser_preview_eval(expression, cx))
    }

    #[cfg(all(feature = "cef", feature = "automation"))]
    pub(crate) fn browser_preview_call(
        &mut self,
        op: &str,
        params: &serde_json::Value,
        cx: &mut Context<'_, Self>,
    ) -> Result<tokio::sync::oneshot::Receiver<Result<serde_json::Value, String>>, String> {
        self.right_panel
            .update(cx, |panel, cx| panel.browser_preview_call(op, params, cx))
    }

    #[cfg(all(feature = "cef", feature = "automation"))]
    pub(crate) fn browser_screenshot(
        &self,
        path: &std::path::Path,
        cx: &App,
    ) -> Result<serde_json::Value, String> {
        self.right_panel.read(cx).browser_screenshot(path, cx)
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
            "serverUrl": self.server_url,
            "status": self.connection_status().map(|s| format!("{s:?}")),
            "projects": self.shell().projects.iter().map(|p| &p.title).collect::<Vec<_>>(),
            "threads": self.shell.threads.iter().map(|t| serde_json::json!({"id": t.id, "title": t.title, "activity": format!("{:?}", self.shell.activity(&t.id))})).collect::<Vec<_>>(),
            "activeThreads": self.shell.top_level_active_threads().map(|t| serde_json::json!({"id": t.id, "title": t.title, "projectId": t.project_id, "activity": format!("{:?}", self.shell.activity(&t.id))})).collect::<Vec<_>>(),
            "settledCount": self.shell.top_level_settled_threads().len(),
            "selected": self.layout.selected_thread_id,
            "draft": self.draft.as_ref().map(|d| serde_json::json!({
                "projectId": d.project_id,
                "useWorktree": d.use_worktree,
                "runtimeMode": d.runtime_mode,
                "interactionMode": d.interaction_mode,
                "launching": d.launching,
            })),
            "sidebarOpen": self.layout.sidebar_open,
            "rightPanel": self.layout.right_panel_open.then(|| format!("{:?}", self.layout.right_panel_tab)),
            "timeline": timeline,
            "palette": self.command_palette.is_some(),
            "settings": self.settings_modal.is_some(),
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
            .chain(self.shell.archived_threads.iter())
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
        let project_id = self
            .shell
            .find_thread(&thread_id)
            .map(|t| t.project_id.clone());
        self.open_thread(thread_id);
        if project_id.is_some() {
            self.layout.selected_project_id = project_id;
        }
        self.chat.update(cx, |chat, cx| chat.set_error(None, cx));
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
        self.sync_browser_visibility(cx);
        cx.notify();
    }

    /// The active right-panel surface.
    fn right_panel_surface(&self) -> PanelSurface {
        match (&self.layout.right_panel_tab, &self.right_panel_file) {
            (RightPanelTab::File, Some(path)) => PanelSurface::File(path.clone()),
            (tab, _) => PanelSurface::Kind(*tab),
        }
    }

    /// Selects a right-panel tab and opens the right panel if it was closed.
    pub(crate) fn select_right_panel_tab(
        &mut self,
        tab: RightPanelTab,
        cx: &mut Context<'_, Self>,
    ) {
        self.select_right_panel_surface(PanelSurface::Kind(tab), cx);
    }

    /// Shows `surface` (opening its tab) and opens the right panel if it was closed.
    pub(crate) fn select_right_panel_surface(
        &mut self,
        surface: PanelSurface,
        cx: &mut Context<'_, Self>,
    ) {
        if !self.right_panel_open_tabs.contains(&surface) {
            self.right_panel_open_tabs.push(surface.clone());
        }
        self.right_panel_add_menu_open = false;
        self.layout.right_panel_tab = surface.kind();
        if let PanelSurface::File(path) = surface {
            self.right_panel_file = Some(path);
        }
        self.layout.right_panel_open = true;
        self.sync_chat(cx);
        self.sync_browser_visibility(cx);
        cx.notify();
    }

    /// Closes a right panel tab; closing the last one closes the panel.
    fn close_right_panel_tab(&mut self, surface: &PanelSurface, cx: &mut Context<'_, Self>) {
        // Closing the last surface closes the panel, as in Conn.
        if self.right_panel_open_tabs.len() <= 1 {
            self.right_panel_add_menu_open = false;
            if self.layout.right_panel_open {
                self.toggle_right_panel(cx);
            }
            return;
        }
        let Some(pos) = self.right_panel_open_tabs.iter().position(|t| t == surface) else {
            return;
        };
        self.right_panel_open_tabs.remove(pos);
        if &self.right_panel_surface() == surface {
            let next = self.right_panel_open_tabs[pos.saturating_sub(1)].clone();
            self.select_right_panel_surface(next, cx);
        } else {
            cx.notify();
        }
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
        self.sync_browser_visibility(cx);
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
        self.sidebar_filter_menu_open = false;
        cx.notify();
    }

    /// Attaches the macOS `conn://` URL receiver and Unix domain control socket server to this
    /// window so Orbit CLI, Rooms, and OS URL handlers can activate workspaces and threads.
    pub(crate) fn attach_activation_channels(
        &mut self,
        mut url_rx: tokio::sync::mpsc::UnboundedReceiver<String>,
        mut control_rx: tokio::sync::mpsc::UnboundedReceiver<
            conn_desktop::control::IncomingControlRequest,
        >,
        control_server: Option<conn_desktop::control::ControlServerHandle>,
        window: gpui_kit::AnyWindowHandle,
        cx: &mut Context<'_, Self>,
    ) {
        self._control_server = control_server;
        let entity = cx.entity().downgrade();
        let task = cx.spawn(async move |_, cx| {
            loop {
                enum Ev {
                    Url(String),
                    Control(conn_desktop::control::IncomingControlRequest),
                    Closed,
                }
                let next = crate::live::RT
                    .spawn(async move {
                        let ev = tokio::select! {
                            maybe_url = url_rx.recv() => match maybe_url {
                                Some(url) => Ev::Url(url),
                                None => Ev::Closed,
                            },
                            maybe_ctrl = control_rx.recv() => match maybe_ctrl {
                                Some(req) => Ev::Control(req),
                                None => Ev::Closed,
                            },
                        };
                        (ev, url_rx, control_rx)
                    })
                    .await;
                let Ok((ev, next_url_rx, next_control_rx)) = next else {
                    break;
                };
                url_rx = next_url_rx;
                control_rx = next_control_rx;
                match ev {
                    Ev::Closed => break,
                    Ev::Url(url) => {
                        let ok = entity.update(cx, |app, cx| {
                            app.handle_deep_link(&url, cx);
                        });
                        if ok.is_err() {
                            break;
                        }
                        let _ = window.update(cx, |_, window, cx| {
                            cx.activate(true);
                            window.activate_window();
                        });
                    }
                    Ev::Control((request, reply_tx)) => {
                        let reply =
                            entity.update(cx, |app, cx| app.handle_control_request(request, cx));
                        match reply {
                            Ok(response) => {
                                let _ = reply_tx.send(response);
                                let _ = window.update(cx, |_, window, cx| {
                                    cx.activate(true);
                                    window.activate_window();
                                });
                            }
                            Err(_) => break,
                        }
                    }
                }
            }
        });
        self._activation_task = Some(task);
    }

    fn workspace_candidates(&self) -> Vec<(String, String)> {
        if !self.orbit.workspaces.is_empty() {
            return self
                .orbit
                .workspaces
                .iter()
                .map(|w| (w.id.clone(), w.name.clone()))
                .collect();
        }
        self.shell
            .projects
            .iter()
            .filter(|p| p.archived_at.is_none())
            .map(|p| (p.id.clone(), p.title.clone()))
            .collect()
    }

    /// Handles a `conn://` or `t3code://` deep link URL.
    pub(crate) fn handle_deep_link(&mut self, raw_url: &str, cx: &mut Context<'_, Self>) -> bool {
        use conn_desktop::control::{DeepLink, match_workspace, parse_deep_link};
        let Some(link) = parse_deep_link(raw_url) else {
            return false;
        };
        match link {
            DeepLink::Workspace(token) => {
                let candidates = self.workspace_candidates();
                match match_workspace(&token, &candidates) {
                    Some(None) => {
                        self.select_workspace(None, cx);
                        true
                    }
                    Some(Some((id, _name))) => {
                        self.select_workspace(Some(id), cx);
                        true
                    }
                    None => false,
                }
            }
            DeepLink::Thread {
                thread_id,
                environment_id,
            } => self.activate_thread(&thread_id, environment_id.as_deref(), cx),
            DeepLink::WorkspaceRoot(root) => self.activate_workspace_root(&root, cx).is_ok(),
        }
    }

    /// Handles one request arriving over Conn's Unix domain control socket.
    pub(crate) fn handle_control_request(
        &mut self,
        request: conn_desktop::control::ControlRequest,
        cx: &mut Context<'_, Self>,
    ) -> conn_desktop::control::ControlResponse {
        use conn_desktop::control::{ControlRequest, ControlResponse, match_workspace};
        match request {
            ControlRequest::SelectWorkspace {
                request_id,
                workspace,
                ..
            } => {
                let candidates = self.workspace_candidates();
                match match_workspace(&workspace, &candidates) {
                    Some(None) => {
                        self.select_workspace(None, cx);
                        ControlResponse::workspace_ok(request_id, None, None)
                    }
                    Some(Some((id, name))) => {
                        self.select_workspace(Some(id.clone()), cx);
                        ControlResponse::workspace_ok(request_id, Some(id), Some(name))
                    }
                    None => ControlResponse::failure(
                        request_id,
                        "workspace-not-found",
                        format!("Workspace \"{workspace}\" was not found."),
                    ),
                }
            }
            ControlRequest::OpenThread {
                request_id,
                environment_id,
                thread_id,
                ..
            } => {
                if let Some(thread) = self.shell.threads.iter().find(|t| t.id == thread_id) {
                    let project_id = thread.project_id.clone();
                    self.select_thread(thread_id.clone(), cx);
                    return ControlResponse::thread_ok(request_id, project_id, thread_id);
                }
                if self.activate_thread(&thread_id, Some(&environment_id), cx) {
                    let project_id = self
                        .shell
                        .threads
                        .iter()
                        .find(|t| t.id == thread_id)
                        .map(|t| t.project_id.clone())
                        .unwrap_or_default();
                    return ControlResponse::thread_ok(request_id, project_id, thread_id);
                }
                ControlResponse::failure(
                    request_id,
                    "thread-not-found",
                    format!("Thread \"{thread_id}\" was not found."),
                )
            }
            ControlRequest::OpenWorkspace {
                request_id,
                workspace_root,
                ..
            } => match self.activate_workspace_root(&workspace_root, cx) {
                Ok((project_id, thread_id)) => {
                    ControlResponse::thread_ok(request_id, project_id, thread_id)
                }
                Err(msg) => ControlResponse::failure(request_id, "thread-open-failed", msg),
            },
        }
    }

    fn activate_thread(
        &mut self,
        thread_id: &str,
        environment_id: Option<&str>,
        cx: &mut Context<'_, Self>,
    ) -> bool {
        if self.shell.threads.iter().any(|t| t.id == thread_id) {
            self.pending_open_thread = None;
            self.select_thread(thread_id.to_owned(), cx);
            return true;
        }
        if let Some(env_id) = environment_id
            && self.orbit.fleet.find_by_server_id(env_id).is_some()
        {
            self.pending_open_thread = Some(thread_id.to_owned());
            self.connect_orbit_target(env_id.to_owned(), cx);
            return true;
        }
        false
    }

    fn activate_workspace_root(
        &mut self,
        workspace_root: &str,
        cx: &mut Context<'_, Self>,
    ) -> Result<(String, String), String> {
        let needle = workspace_root.trim().trim_end_matches('/');
        let project = self
            .shell
            .projects
            .iter()
            .find(|p| p.workspace_root.trim_end_matches('/') == needle)
            .cloned()
            .ok_or_else(|| format!("No project matches workspace root \"{workspace_root}\"."))?;

        if let Some(thread) = self
            .shell
            .threads
            .iter()
            .find(|t| t.project_id == project.id && t.settled_at.is_none())
            .or_else(|| {
                self.shell
                    .threads
                    .iter()
                    .find(|t| t.project_id == project.id)
            })
        {
            let tid = thread.id.clone();
            self.select_thread(tid.clone(), cx);
            return Ok((project.id, tid));
        }

        self.start_new_thread(Some(project.id.clone()), None, cx);
        Ok((project.id, String::new()))
    }

    /// Toggles the sidebar project-scope filter popover menu.
    pub(crate) fn toggle_sidebar_filter_menu(&mut self, cx: &mut Context<'_, Self>) {
        self.sidebar_filter_menu_open = !self.sidebar_filter_menu_open;
        cx.notify();
    }

    /// Moves `thread_id` into (`settled = true`) or out of (`settled = false`) the Settled shelf.
    pub(crate) fn settle_thread(
        &mut self,
        thread_id: String,
        settled: bool,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(connection) = self.connection.clone() else {
            return;
        };
        let Ok(cmd) = crate::commands::settle_thread(&thread_id, settled) else {
            return;
        };
        cx.spawn(async move |_, _| {
            if let Err(e) = connection.dispatch_command(cmd).await {
                eprintln!("settle: dispatchCommand failed: {e}");
            }
        })
        .detach();
    }

    /// Starts inline renaming for `thread_id` in the sidebar.
    pub(crate) fn start_thread_rename(
        &mut self,
        thread_id: String,
        current_title: String,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.renaming_thread_id = Some(thread_id);
        self.rename_input.update(cx, |input, cx| {
            input.set_value(current_title, window, cx);
            input.focus(window, cx);
        });
        cx.notify();
    }

    /// Commits the active inline thread rename via `thread.metadata.update`.
    pub(crate) fn commit_thread_rename(&mut self, cx: &mut Context<'_, Self>) {
        let Some(thread_id) = self.renaming_thread_id.take() else {
            return;
        };
        let next_title = self.rename_input.read(cx).value().trim().to_owned();
        if next_title.is_empty() {
            cx.notify();
            return;
        }
        let Some(connection) = self.connection.clone() else {
            cx.notify();
            return;
        };
        let Ok(cmd) = crate::commands::rename_thread(&thread_id, &next_title) else {
            cx.notify();
            return;
        };
        cx.spawn(async move |_, _| {
            if let Err(e) = connection.dispatch_command(cmd).await {
                eprintln!("rename thread: dispatchCommand failed: {e}");
            }
        })
        .detach();
        cx.notify();
    }

    /// Cancels inline thread renaming without saving.
    pub(crate) fn cancel_thread_rename(&mut self, cx: &mut Context<'_, Self>) {
        if self.renaming_thread_id.take().is_some() {
            cx.notify();
        }
    }

    /// Opens a native folder picker and registers the selected directory via `projects.mutate`
    /// (`project.create`).
    pub(crate) fn add_project_via_picker(
        &mut self,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(connection) = self.connection.clone() else {
            return;
        };
        let paths = cx.prompt_for_paths(gpui_kit::PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Add project".into()),
        });
        cx.spawn_in(window, async move |_this, _cx| {
            let Ok(Ok(Some(mut chosen))) = paths.await else {
                return;
            };
            let Some(path) = chosen.pop() else {
                return;
            };
            let workspace_root = path.to_string_lossy().trim_end_matches('/').to_owned();
            if workspace_root.is_empty() {
                return;
            }
            let title = path
                .file_name()
                .and_then(|n| n.to_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("Project")
                .to_owned();
            let Ok(mutation) = crate::commands::create_project_mutation(&workspace_root, &title)
            else {
                return;
            };
            if let Err(err) = connection
                .call::<conn_contract::rpc::projects::mutate::Payload, conn_contract::rpc::projects::mutate::Success>(
                    "projects.mutate",
                    &mutation,
                )
                .await
            {
                eprintln!("add project: projects.mutate failed: {err}");
            }
        })
        .detach();
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
        let header = render_chat_header(
            &self.shell,
            &self.layout,
            self.draft.as_ref().map(|d| d.project_id.as_str()),
            &self.tokens,
            &self.geometry,
            cx,
        );

        let join = CardJoin {
            left: self.layout.sidebar_open,
            right: self.layout.right_panel_open,
        };

        // Matches real Conn (`ChatView.tsx`): the chat card re-roots `--background` to opaque
        // `--shell-card` (`bg-background`), keeping the chat surface deeper than the glossy outer
        // shell and slightly deeper than the translucent sidebar card.
        let chat_card = inset_card(&self.tokens, &self.geometry, join)
            .bg(hsla(self.tokens.shell_card))
            .child(self.chat.clone());

        div()
            .id("conn-chat-column")
            .a11y(gpui_kit::Role::Main, "shell.chat-column", "Conversation")
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .h_full()
            .child(header)
            .child(chat_card)
    }

    /// Surfaces the add menu enables, by Conn's rules (`SURFACE_DISABLED_REASONS`): Browser and
    /// Tasks are always available; project/thread surfaces (including Pull request and Linked
    /// items, which render Conn's link/empty states when no PR is attached yet) need a thread.
    fn available_right_panel_tabs(&self) -> Vec<RightPanelTab> {
        let thread = self.layout.selected_thread_id.is_some();
        RightPanelTab::MENU_ORDER
            .into_iter()
            .filter(|tab| match tab {
                RightPanelTab::Browser | RightPanelTab::Tasks => true,
                _ => thread,
            })
            .collect()
    }

    /// Handles a key while the add-surface menu is open: a surface's letter opens it, Escape
    /// closes the menu. Returns whether the key was used.
    fn handle_add_menu_key(
        &mut self,
        event: &gpui_kit::KeyDownEvent,
        cx: &mut Context<'_, Self>,
    ) -> bool {
        if !self.right_panel_add_menu_open {
            return false;
        }
        let keystroke = &event.keystroke;
        let modifiers = keystroke.modifiers;
        if modifiers.control || modifiers.platform || modifiers.alt {
            return false;
        }
        if keystroke.key == "escape" {
            self.right_panel_add_menu_open = false;
            cx.notify();
            return true;
        }
        if let Some(tab) = RightPanelTab::from_menu_shortcut(&keystroke.key)
            && self.available_right_panel_tabs().contains(&tab)
        {
            self.right_panel_add_menu_open = false;
            self.select_right_panel_tab(tab, cx);
            return true;
        }
        false
    }

    fn render_right_panel_column(&self, cx: &mut Context<'_, Self>) -> impl IntoElement {
        use crate::panels::header::{PanelHeaderCallbacks, PanelHeaderProps, render_panel_header};
        use std::rc::Rc;
        let app = cx.entity();
        let available_tabs = self.available_right_panel_tabs();
        let active_surface = self.right_panel_surface();
        let header = render_panel_header(
            PanelHeaderProps {
                open_tabs: &self.right_panel_open_tabs,
                active_tab: &active_surface,
                maximized: self.right_panel_maximized,
                bottom_dock_open: false,
                panel_open: self.layout.right_panel_open,
                add_menu_open: self.right_panel_add_menu_open,
                available_tabs: &available_tabs,
                tokens: &self.tokens,
            },
            PanelHeaderCallbacks {
                on_select_tab: {
                    let app = app.clone();
                    Rc::new(move |tab, _, cx| {
                        app.update(cx, |this, cx| this.select_right_panel_surface(tab, cx));
                    })
                },
                on_close_tab: Some({
                    let app = app.clone();
                    Rc::new(move |tab, _, cx| {
                        app.update(cx, |this, cx| this.close_right_panel_tab(&tab, cx));
                    })
                }),
                on_toggle_add_menu: {
                    let app = app.clone();
                    Rc::new(move |window, cx| {
                        app.update(cx, |this, cx| {
                            this.right_panel_add_menu_open = !this.right_panel_add_menu_open;
                            if this.right_panel_add_menu_open {
                                // Conn focuses the trigger, so the menu's letter keys and
                                // Escape reach it whatever had the keyboard before.
                                window.focus(&this.focus_handle, cx);
                            }
                            cx.notify();
                        });
                    })
                },
                on_add_tab: {
                    let app = app.clone();
                    Rc::new(move |tab, _, cx| {
                        app.update(cx, |this, cx| this.select_right_panel_tab(tab, cx));
                    })
                },
                on_toggle_maximize: {
                    let app = app.clone();
                    Rc::new(move |_, cx| {
                        app.update(cx, |this, cx| {
                            this.right_panel_maximized = !this.right_panel_maximized;
                            cx.notify();
                        });
                    })
                },
                on_toggle_dock_bottom: Rc::new(|_, _| {
                    eprintln!("right panel: dock to bottom is not implemented yet");
                }),
                on_toggle_panel: Rc::new(move |_, cx| {
                    app.update(cx, |this, cx| {
                        this.right_panel_add_menu_open = false;
                        this.toggle_right_panel(cx);
                    });
                }),
            },
        );

        // Matches real Conn (`RightPanelTabs.tsx`): right-panel cards paint opaque `--shell-card`
        // (`[--background:var(--shell-card)]`), preserving crisp contrast against the lighter
        // glossy outer shell.
        let card = inset_card(
            &self.tokens,
            &self.geometry,
            CardJoin {
                left: true,
                right: false,
            },
        )
        .bg(hsla(self.tokens.shell_card))
        .child(self.right_panel.clone());

        let column = div()
            .id("conn-right-panel-column")
            .a11y(
                gpui_kit::Role::Complementary,
                "shell.right-panel-column",
                "Right panel",
            )
            .flex()
            .flex_col()
            .h_full();
        let column = if self.right_panel_maximized {
            column.flex_1().min_w_0()
        } else {
            column.w(px(self.layout.right_panel_width)).flex_shrink_0()
        };
        column.child(header).child(card)
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

    /// Dev loop: applies `CONN_GPUI_THEME_FILE` now and again whenever the file changes, so
    /// theme colors and the shell tokens derived from them can be tuned live, no rebuild.
    fn watch_theme_file(path: std::path::PathBuf, cx: &mut Context<'_, Self>) {
        cx.spawn(async move |this, cx| {
            let mut seen: Option<std::time::SystemTime> = None;
            loop {
                let modified = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
                if modified.is_some() && modified != seen {
                    seen = modified;
                    let loaded = crate::live::load_theme_file(&path);
                    let alive = this.update(cx, |app, cx| match loaded {
                        Ok((theme, tokens)) => {
                            eprintln!("theme file: applied {}", path.display());
                            app.theme_id = theme.id;
                            app.set_tokens(tokens, cx);
                        }
                        Err(error) => eprintln!("theme file: {error}"),
                    });
                    if alive.is_err() {
                        break;
                    }
                }
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(300))
                    .await;
            }
        })
        .detach();
    }

    /// Resolves a theme definition from built-in themes or Orbit-synced custom themes.
    fn resolve_theme(&self, theme_id: &str) -> Option<(conn_theme::ThemeDefinition, Tokens)> {
        if let Some(found) = crate::live::tokens_for(theme_id) {
            return Some(found);
        }
        let custom = self
            .orbit
            .custom_themes
            .iter()
            .find(|t| t.id == theme_id)?
            .clone();
        let tokens = Tokens::derive(&custom);
        Some((custom, tokens))
    }

    /// Switches to a built-in or Orbit-synced custom theme by id and syncs the choice to Orbit.
    pub(crate) fn set_theme(&mut self, theme_id: &str, cx: &mut Context<'_, Self>) -> bool {
        self.apply_theme_choice(theme_id, true, cx)
    }

    fn apply_theme_choice(
        &mut self,
        theme_id: &str,
        push_to_orbit: bool,
        cx: &mut Context<'_, Self>,
    ) -> bool {
        let Some((theme, tokens)) = self.resolve_theme(theme_id) else {
            return false;
        };
        self.theme_id = theme.id.clone();
        self.set_tokens(tokens, cx);
        if push_to_orbit {
            self.push_orbit_appearance(&theme, cx);
        }
        true
    }

    /// Display name advertised to `conn-server` on the `panels.requests` stream.
    fn device_name(&self) -> String {
        self.orbit
            .node
            .as_ref()
            .map(|n| n.name.clone())
            .unwrap_or_else(default_device_name)
    }

    /// Synchronizes `annotations.subscribe` for the active project, pushes the queue into the
    /// Browser and Device panels, and runs Watch auto-dispatch when the active thread is idle.
    fn sync_annotations_state(&mut self, project_id: Option<&str>, cx: &mut Context<'_, Self>) {
        if self.subscribed_annotation_project.as_deref() != project_id {
            if let Some(old) = self.subscribed_annotation_project.take()
                && let Some(conn) = &self.connection
            {
                conn.unsubscribe_annotations(&old);
            }
            self.annotations.clear();
            if let Some(next) = project_id {
                self.subscribed_annotation_project = Some(next.to_owned());
                if let Some(conn) = &self.connection {
                    conn.subscribe_annotations(next);
                }
            }
        }

        let thread_id = self.layout.selected_thread_id.clone();
        let watching = thread_id
            .as_deref()
            .is_some_and(|id| self.annotation_watching_threads.contains(id));
        let project_ready = project_id.is_some() && self.connection.is_some();

        self.right_panel.update(cx, |panel, cx| {
            panel.set_annotations(self.annotations.clone(), watching, project_ready, cx);
        });

        self.maybe_auto_send_annotations(cx);
    }

    fn maybe_auto_send_annotations(&mut self, cx: &mut Context<'_, Self>) {
        let Some(thread_id) = self.layout.selected_thread_id.clone() else {
            return;
        };
        let watching = self.annotation_watching_threads.contains(&thread_id);
        let thread_idle = !self
            .threads
            .get(&thread_id)
            .is_some_and(|timeline| timeline.working);
        let last_sent = self
            .annotation_last_sent
            .get(&thread_id)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let to_send =
            conn_state::waiting_ids_to_send(watching, thread_idle, &self.annotations, last_sent);
        if to_send.is_empty() {
            return;
        }
        self.annotation_last_sent.insert(thread_id, to_send);
        let prompt = conn_state::build_annotation_prompt(&self.annotations);
        self.send_prompt(prompt, cx);
    }

    fn handle_annotation_action(
        &mut self,
        action: crate::panels::annotations::AnnotationAction,
        cx: &mut Context<'_, Self>,
    ) {
        use crate::panels::annotations::AnnotationAction;

        match action {
            AnnotationAction::Create(annotation) => {
                let (Some(conn), Some(project_id)) = (
                    self.connection.clone(),
                    self.subscribed_annotation_project.clone(),
                ) else {
                    return;
                };
                let input = conn_contract::AnnotationCreateInput {
                    project_id,
                    annotation,
                };
                cx.spawn(async move |_, _| {
                    let _ = crate::live::RT
                        .spawn(async move {
                            let res = conn
                                .call::<conn_contract::AnnotationCreateInput, conn_contract::AnnotationCreateResult>(
                                    "annotations.create",
                                    &input,
                                )
                                .await;
                            if let Err(err) = res {
                                eprintln!("annotations.create failed: {err}");
                            }
                        })
                        .await;
                })
                .detach();
            }
            AnnotationAction::Remove { ids } => {
                if ids.is_empty() {
                    return;
                }
                let (Some(conn), Some(project_id)) = (
                    self.connection.clone(),
                    self.subscribed_annotation_project.clone(),
                ) else {
                    return;
                };
                let input = conn_contract::AnnotationRemoveInput {
                    project_id,
                    ids: Some(ids),
                    scope: None,
                };
                cx.spawn(async move |_, _| {
                    let _ = crate::live::RT
                        .spawn(async move {
                            let res = conn
                                .call::<conn_contract::AnnotationRemoveInput, conn_contract::AnnotationRemoveResult>(
                                    "annotations.remove",
                                    &input,
                                )
                                .await;
                            if let Err(err) = res {
                                eprintln!("annotations.remove failed: {err}");
                            }
                        })
                        .await;
                })
                .detach();
            }
            AnnotationAction::SendWaiting => {
                let waiting_ids: Vec<String> = self
                    .annotations
                    .iter()
                    .filter(|r| {
                        conn_state::annotation_state(r) == conn_state::AnnotationQueueState::Waiting
                    })
                    .map(|r| r.id.clone())
                    .collect();
                if waiting_ids.is_empty() {
                    return;
                }
                if let Some(thread_id) = self.layout.selected_thread_id.clone() {
                    self.annotation_last_sent.insert(thread_id, waiting_ids);
                }
                let prompt = conn_state::build_annotation_prompt(&self.annotations);
                self.send_prompt(prompt, cx);
            }
            AnnotationAction::ToggleWatch => {
                let Some(thread_id) = self.layout.selected_thread_id.clone() else {
                    return;
                };
                if !self.annotation_watching_threads.remove(&thread_id) {
                    self.annotation_watching_threads.insert(thread_id);
                }
                let project_id = self.subscribed_annotation_project.clone();
                self.sync_annotations_state(project_id.as_deref(), cx);
                cx.notify();
            }
        }
    }

    /// Dispatches one agent panel request received on `conn-client`'s auto-resubscribed
    /// `panels.requests` stream (`panel_open`, `database_query`, `mcp_connect`, `mcp_call`) and
    /// replies via `panels.respond`.
    fn dispatch_agent_panel_request(
        &self,
        request: conn_contract::AgentPanelRequest,
        cx: &mut Context<'_, Self>,
    ) {
        const NOT_ON_THREAD: &str = "The user is looking at another thread, so Conn did not run this. Ask them to open your thread, then try again.";

        let Some(conn_reply) = self.connection.clone() else {
            return;
        };
        let device_name = self.device_name();
        cx.spawn(async move |this, cx| {
            let response =
                Self::handle_agent_panel_request(this, request, device_name, NOT_ON_THREAD, cx)
                    .await;
            let _ = crate::live::RT
                .spawn(async move {
                    let _ = conn_reply
                        .call::<conn_contract::AgentPanelResponse, ()>("panels.respond", &response)
                        .await;
                })
                .await;
        })
        .detach();
    }

    async fn handle_agent_panel_request(
        this: gpui_kit::WeakEntity<Self>,
        request: conn_contract::AgentPanelRequest,
        device_name: String,
        not_on_thread: &str,
        cx: &mut gpui_kit::AsyncApp,
    ) -> conn_contract::AgentPanelResponse {
        use conn_contract::{AgentPanelKind, AgentPanelResponse};

        let mut resp = AgentPanelResponse {
            request_id: request.request_id.clone(),
            ok: true,
            device_name: Some(device_name),
            error: None,
            database: None,
            mcp: None,
            mcp_call: None,
        };

        let on_thread = this
            .read_with(cx, |app, _| {
                app.layout.selected_thread_id.as_deref() == Some(request.thread_id.as_str())
            })
            .unwrap_or(false);

        if !on_thread {
            if request.panel == AgentPanelKind::Database
                && let Some(sql) = request.sql.clone()
            {
                let _ = this.update(cx, |app, cx| {
                    app.right_panel
                        .update(cx, |panel, cx| panel.set_database_sql(sql, cx));
                });
                if request.run == Some(true) {
                    resp.ok = false;
                    resp.error = Some(format!(
                        "{not_on_thread} The query is in its Database panel."
                    ));
                }
                return resp;
            }
            if request.panel == AgentPanelKind::Mcp
                && (request.mcp_server.is_some() || request.mcp_call.is_some())
            {
                resp.ok = false;
                resp.error = Some(not_on_thread.to_owned());
                return resp;
            }
            return resp;
        }

        let target_tab = match request.panel {
            AgentPanelKind::Browser => RightPanelTab::Browser,
            AgentPanelKind::Database => RightPanelTab::Database,
            AgentPanelKind::Mcp => RightPanelTab::Mcp,
            AgentPanelKind::Diff => RightPanelTab::Diff,
            AgentPanelKind::Files => RightPanelTab::Files,
        };

        let _ = this.update(cx, |app, cx| {
            app.select_right_panel_tab(target_tab, cx);
        });

        match request.panel {
            AgentPanelKind::Database => {
                if let Some(sql) = request.sql {
                    if request.run == Some(true) {
                        let rx = this.update(cx, |app, cx| {
                            app.right_panel.update(cx, |panel, cx| {
                                panel.run_agent_database_query(sql, request.connection, cx)
                            })
                        });
                        match rx {
                            Ok(rx) => match rx.await {
                                Ok(Ok(db_res)) => resp.database = Some(db_res),
                                Ok(Err(err)) => {
                                    resp.ok = false;
                                    resp.error = Some(err);
                                }
                                Err(_) => {
                                    resp.ok = false;
                                    resp.error = Some("Database query cancelled.".to_owned());
                                }
                            },
                            Err(_) => {
                                resp.ok = false;
                                resp.error = Some("Conn window closed.".to_owned());
                            }
                        }
                    } else {
                        let _ = this.update(cx, |app, cx| {
                            app.right_panel
                                .update(cx, |panel, cx| panel.set_database_sql(sql, cx));
                        });
                    }
                }
            }
            AgentPanelKind::Mcp => {
                if let Some(call) = request.mcp_call {
                    let rx = this.update(cx, |app, cx| {
                        app.right_panel
                            .update(cx, |panel, cx| panel.run_agent_mcp_call(call, cx))
                    });
                    match rx {
                        Ok(rx) => match rx.await {
                            Ok(Ok(call_res)) => resp.mcp_call = Some(call_res),
                            Ok(Err(err)) => {
                                resp.ok = false;
                                resp.error = Some(err);
                            }
                            Err(_) => {
                                resp.ok = false;
                                resp.error = Some("MCP tool call cancelled.".to_owned());
                            }
                        },
                        Err(_) => {
                            resp.ok = false;
                            resp.error = Some("Conn window closed.".to_owned());
                        }
                    }
                } else if let Some(spec) = request.mcp_server {
                    let rx = this.update(cx, |app, cx| {
                        app.right_panel
                            .update(cx, |panel, cx| panel.run_agent_mcp_connect(spec, cx))
                    });
                    match rx {
                        Ok(rx) => match rx.await {
                            Ok(Ok(mcp_res)) => resp.mcp = Some(mcp_res),
                            Ok(Err(err)) => {
                                resp.ok = false;
                                resp.error = Some(err);
                            }
                            Err(_) => {
                                resp.ok = false;
                                resp.error = Some("MCP connect cancelled.".to_owned());
                            }
                        },
                        Err(_) => {
                            resp.ok = false;
                            resp.error = Some("Conn window closed.".to_owned());
                        }
                    }
                }
            }
            AgentPanelKind::Browser | AgentPanelKind::Diff | AgentPanelKind::Files => {}
        }

        resp
    }

    /// Listens to app-wide Orbit Gateway Reverb notices (`FleetChanged`, `ProfileChanged`) on
    /// the shared `private-orbit` WebSocket so Nodes, Instances, and profiles refresh live.
    fn pump_orbit_realtime(
        mut events: tokio::sync::broadcast::Receiver<conn_desktop::orbit::OrbitRealtimeEvent>,
        cx: &mut Context<'_, Self>,
    ) {
        cx.spawn(async move |this, cx| {
            loop {
                let recv = crate::live::RT
                    .spawn(async move {
                        let item = events.recv().await;
                        (item, events)
                    })
                    .await;
                let Ok((item, next_rx)) = recv else {
                    break;
                };
                events = next_rx;
                let event = match item {
                    Ok(ev) => ev,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        conn_desktop::orbit::OrbitRealtimeEvent::FleetChanged
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                };
                let alive = this.update(cx, |app, cx| match event {
                    conn_desktop::orbit::OrbitRealtimeEvent::FleetChanged => {
                        app.refresh_orbit_fleet(cx);
                    }
                    conn_desktop::orbit::OrbitRealtimeEvent::ProfileChanged => {
                        app.sync_orbit_profile(true, cx);
                    }
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
    }

    /// Background refresh of the Orbit Nodes & Instances fleet triggered by Reverb notices.
    fn refresh_orbit_fleet(&mut self, cx: &mut Context<'_, Self>) {
        let local_node = self.orbit.node.as_ref().map(|n| n.name.clone());
        cx.spawn(async move |this, cx| {
            let task = crate::live::RT.spawn(crate::orbit_sync::fetch_orbit_fleet(local_node));
            if let Ok(Ok(fleet)) = task.await {
                let _ = this.update(cx, |app, cx| {
                    app.orbit.fleet = fleet;
                    app.refresh_settings_orbit_info(cx);
                    cx.notify();
                });
            }
        })
        .detach();
    }

    /// Syncs workspaces, appearance, and desktop settings from Orbit Gateway on `live::RT`.
    pub(crate) fn sync_orbit_profile(
        &mut self,
        allow_theme_adopt: bool,
        cx: &mut Context<'_, Self>,
    ) {
        self.orbit.status = crate::orbit_sync::OrbitSyncStatus::Syncing;
        self.refresh_settings_orbit_info(cx);
        cx.spawn(async move |this, cx| {
            let task = crate::live::RT.spawn(crate::orbit_sync::fetch_orbit_profile());
            let outcome = match task.await {
                Ok(res) => res,
                Err(err) => Err(conn_desktop::orbit::ProfileError::Unreachable(
                    err.to_string(),
                )),
            };
            let _ = this.update(cx, |app, cx| {
                app.finish_orbit_fetch(outcome, allow_theme_adopt, cx);
            });
        })
        .detach();
    }

    /// Binds this device's Orbit Node to `profile_id` and adopts its synced workspaces & themes.
    fn bind_orbit_profile(&mut self, profile_id: i64, cx: &mut Context<'_, Self>) {
        self.orbit.status = crate::orbit_sync::OrbitSyncStatus::Syncing;
        self.refresh_settings_orbit_info(cx);
        cx.spawn(async move |this, cx| {
            let task =
                crate::live::RT.spawn(crate::orbit_sync::bind_and_fetch_orbit_profile(profile_id));
            let outcome = match task.await {
                Ok(res) => res,
                Err(err) => Err(conn_desktop::orbit::ProfileError::Unreachable(
                    err.to_string(),
                )),
            };
            let _ = this.update(cx, |app, cx| {
                app.finish_orbit_fetch(outcome, true, cx);
            });
        })
        .detach();
    }

    fn finish_orbit_fetch(
        &mut self,
        outcome: Result<crate::orbit_sync::OrbitFetchResult, conn_desktop::orbit::ProfileError>,
        allow_theme_adopt: bool,
        cx: &mut Context<'_, Self>,
    ) {
        match outcome {
            Ok(result) => {
                let effects =
                    self.orbit
                        .apply_fetch(result, self.tokens.appearance, allow_theme_adopt);
                if let Some(reduce) = effects.reduce_transparency {
                    self.apply_reduce_transparency_choice(reduce, false, cx);
                }
                if let Some(theme_id) = effects.theme_id
                    && theme_id != self.theme_id
                {
                    let _ = self.apply_theme_choice(&theme_id, false, cx);
                }
                // Auto-connect to the local (or previously active) Orbit Node when launched
                // without an explicit server or demo mode flag.
                if self.connection.is_none()
                    && !crate::live::demo_mode_enabled()
                    && self.orbit.connecting_server_id.is_none()
                {
                    let preferred = self
                        .orbit
                        .sessions
                        .active_server_id
                        .as_deref()
                        .and_then(|sid| self.orbit.fleet.find_by_server_id(sid))
                        .filter(|t| t.is_awake())
                        .or_else(|| self.orbit.fleet.nodes.first())
                        .map(|t| t.server_id.clone());
                    if let Some(server_id) = preferred {
                        self.connect_orbit_target(server_id, cx);
                    }
                }
            }
            Err(err) => {
                self.orbit.status = crate::orbit_sync::OrbitSyncStatus::Offline(err.to_string());
            }
        }
        self.refresh_settings_orbit_info(cx);
        cx.notify();
    }

    fn push_orbit_appearance(
        &mut self,
        theme: &conn_theme::ThemeDefinition,
        cx: &mut Context<'_, Self>,
    ) {
        if !crate::orbit_sync::orbit_sync_enabled_by_env()
            || !self.orbit.snapshot.prefs.sync_appearance
        {
            return;
        }
        let Some(profile_id) = self.orbit.active_profile_id() else {
            return;
        };
        let local = self.orbit.build_appearance_document(theme);
        let base = self.orbit.snapshot.appearance_base.clone();
        let version = self.orbit.snapshot.appearance_version;
        cx.spawn(async move |this, cx| {
            let task = crate::live::RT.spawn(crate::orbit_sync::push_appearance_section(
                profile_id, base, local, version,
            ));
            if let Ok(Ok(saved)) = task.await {
                let _ = this.update(cx, |app, cx| {
                    app.orbit.snapshot.profile_version = saved.version;
                    if let Some(meta) = saved
                        .sections
                        .as_ref()
                        .and_then(|s| s.get(conn_desktop::orbit::APPEARANCE_SECTION))
                        .cloned()
                    {
                        app.orbit.snapshot.appearance_version = meta.version;
                        app.orbit.snapshot.appearance_meta = Some(meta);
                    }
                    if let Some(raw) = conn_desktop::orbit::extract_section(
                        &saved,
                        conn_desktop::orbit::APPEARANCE_SECTION,
                    ) {
                        app.orbit.snapshot.appearance_base = Some(raw);
                    }
                    app.orbit.persist_snapshot();
                    app.refresh_settings_orbit_info(cx);
                });
            }
        })
        .detach();
    }

    fn push_orbit_desktop_settings(
        &mut self,
        reduce_transparency: bool,
        cx: &mut Context<'_, Self>,
    ) {
        if !crate::orbit_sync::orbit_sync_enabled_by_env()
            || !self.orbit.snapshot.prefs.sync_desktop_settings
        {
            return;
        }
        let Some(profile_id) = self.orbit.active_profile_id() else {
            return;
        };
        let local = self
            .orbit
            .build_desktop_settings_document(reduce_transparency);
        let base = self.orbit.snapshot.desktop_base.clone();
        let version = self.orbit.snapshot.desktop_version;
        cx.spawn(async move |this, cx| {
            let task = crate::live::RT.spawn(crate::orbit_sync::push_desktop_section(
                profile_id, base, local, version,
            ));
            if let Ok(Ok(saved)) = task.await {
                let _ = this.update(cx, |app, cx| {
                    app.orbit.snapshot.profile_version = saved.version;
                    if let Some(meta) = saved
                        .sections
                        .as_ref()
                        .and_then(|s| s.get(conn_desktop::orbit::DESKTOP_DEVICE_SECTION))
                        .cloned()
                    {
                        app.orbit.snapshot.desktop_version = meta.version;
                        app.orbit.snapshot.desktop_meta = Some(meta);
                    }
                    if let Some(raw) = conn_desktop::orbit::extract_section(
                        &saved,
                        conn_desktop::orbit::DESKTOP_DEVICE_SECTION,
                    ) {
                        app.orbit.snapshot.desktop_base = Some(raw);
                    }
                    app.orbit.persist_snapshot();
                    app.refresh_settings_orbit_info(cx);
                });
            }
        })
        .detach();
    }

    /// Switches the active live `conn-server` connection to a new [`ServerConfig`] (e.g. an Orbit
    /// Node or Instance), cleanly resetting shell/thread state and updating chat & right panels.
    fn connect_to_server_config(
        &mut self,
        config: ServerConfig,
        orbit_server_id: Option<String>,
        label: Option<String>,
        cx: &mut Context<'_, Self>,
    ) {
        self.connection_gen = self.connection_gen.wrapping_add(1);
        let generation = self.connection_gen;
        self.server_url = Some(config.http_base_url.to_string());
        self.server_label = label;
        self.status = Some(ConnectionStatus::Connecting);
        self.orbit.active_server_id = orbit_server_id.clone();
        self.orbit.connecting_server_id = orbit_server_id.clone();
        self.orbit.notice = None;

        self.shell = ShellState::default();
        self.threads.clear();
        self.ended_threads.clear();
        self.subscribed_thread_id = None;
        self.subscribed_annotation_project = None;
        self.annotations.clear();
        self.annotation_last_sent.clear();
        self.layout.selected_thread_id = None;
        self.layout.selected_project_id = None;
        self.draft = None;

        let (connection, events) = Connection::start(config, crate::live::RT.handle());
        connection.subscribe_shell();
        connection.subscribe_panel_requests(Some(self.device_name()));
        Self::pump_events(generation, orbit_server_id, events, cx);

        self.connection = Some(connection.clone());
        self.chat.update(cx, |chat, cx| {
            chat.set_error(None, cx);
            chat.set_connection(Some(connection.clone()), cx);
        });
        self.right_panel
            .update(cx, |panel, cx| panel.set_connection(Some(connection), cx));
        self.sync_chat(cx);
        self.refresh_settings_orbit_info(cx);
        cx.notify();
    }

    /// Connects directly to a user-entered `conn-server` pairing URL or base URL + bearer token
    /// from Settings → Connections, persisting the bearer for automatic reconnect on next launch.
    fn connect_direct_server(
        &mut self,
        raw_url: String,
        bearer_token: String,
        cx: &mut Context<'_, Self>,
    ) {
        let token_opt = (!bearer_token.trim().is_empty()).then_some(bearer_token.as_str());
        let parsed = match conn_desktop::server_store::parse_server_input(&raw_url, token_opt) {
            Ok(parsed) => parsed,
            Err(err) => {
                self.orbit.notice = Some(err);
                self.refresh_settings_orbit_info(cx);
                cx.notify();
                return;
            }
        };
        self.env_pinned_server = false;
        let (http_base_url, credential, immediate_bearer) = match parsed {
            conn_desktop::server_store::ParsedServerInput::Pairing {
                http_base_url,
                pairing_code,
            } => (
                http_base_url,
                conn_client::Credential::PairingCode(pairing_code),
                None,
            ),
            conn_desktop::server_store::ParsedServerInput::Bearer {
                http_base_url,
                bearer,
            } => (
                http_base_url,
                conn_client::Credential::Bearer(bearer.clone()),
                Some(bearer),
            ),
        };
        let label = http_base_url
            .host_str()
            .map(|h| match http_base_url.port() {
                Some(port) => format!("{h}:{port}"),
                None => h.to_owned(),
            });
        if let Some(bearer) = immediate_bearer {
            let saved = conn_desktop::server_store::SavedServerConfig::new(
                http_base_url.to_string(),
                label.clone(),
                bearer,
            );
            if let Err(err) = saved.save_default() {
                eprintln!("server store: failed to persist direct server: {err}");
            }
        }
        self.connect_to_server_config(
            ServerConfig {
                http_base_url,
                credential,
            },
            None,
            label,
            cx,
        );
    }

    /// Connects to an Orbit Node or running Orbit Instance, reusing a cached local bearer token
    /// when available or minting a one-time pairing URL automatically from Orbit Gateway.
    pub(crate) fn connect_orbit_target(&mut self, server_id: String, cx: &mut Context<'_, Self>) {
        let Some(target) = self.orbit.fleet.find_by_server_id(&server_id).cloned() else {
            self.orbit.notice = Some(format!("Orbit target {server_id} was not found."));
            self.refresh_settings_orbit_info(cx);
            return;
        };

        if let Some(bearer) = self
            .orbit
            .sessions
            .bearer_for(&server_id)
            .map(str::to_owned)
            && let Ok(http_base_url) = url::Url::parse(&target.url)
        {
            let config = ServerConfig {
                http_base_url,
                credential: conn_client::Credential::Bearer(bearer),
            };
            self.connect_to_server_config(
                config,
                Some(target.server_id.clone()),
                Some(target.display_title()),
                cx,
            );
            return;
        }

        self.orbit.connecting_server_id = Some(server_id.clone());
        self.orbit.notice = Some(format!("Pairing with {}…", target.display_title()));
        self.refresh_settings_orbit_info(cx);
        cx.notify();

        let target_title = target.display_title();
        let target_url = target.url;
        cx.spawn(async move |this, cx| {
            let task =
                crate::live::RT.spawn(crate::orbit_sync::mint_orbit_pairing(server_id.clone()));
            let outcome = match task.await {
                Ok(res) => res,
                Err(err) => Err(conn_desktop::orbit::ProfileError::Unreachable(
                    err.to_string(),
                )),
            };
            let _ = this.update(cx, |app, cx| match outcome {
                Ok(ticket) => {
                    let Some(code) = ticket.pairing_code() else {
                        app.orbit.connecting_server_id = None;
                        app.orbit.notice = Some(format!(
                            "Gateway returned invalid pairing URL for {target_title}."
                        ));
                        app.refresh_settings_orbit_info(cx);
                        cx.notify();
                        return;
                    };
                    let base = ticket
                        .http_base_url()
                        .or_else(|| url::Url::parse(&target_url).ok());
                    let Some(http_base_url) = base else {
                        app.orbit.connecting_server_id = None;
                        app.orbit.notice = Some(format!("Invalid server URL for {target_title}."));
                        app.refresh_settings_orbit_info(cx);
                        cx.notify();
                        return;
                    };
                    let config = ServerConfig {
                        http_base_url,
                        credential: conn_client::Credential::PairingCode(code),
                    };
                    app.connect_to_server_config(config, Some(server_id), Some(target_title), cx);
                }
                Err(err) => {
                    eprintln!("orbit pairing failed for {target_title}: {err}");
                    app.orbit.connecting_server_id = None;
                    app.orbit.notice = Some(format!("Pairing failed for {target_title}: {err}"));
                    app.refresh_settings_orbit_info(cx);
                    cx.notify();
                }
            });
        })
        .detach();
    }

    /// Wakes a stopped Orbit Instance via `POST /api/v1/instances/{id}/wake` and refreshes the
    /// Orbit fleet once accepted.
    fn wake_orbit_instance(
        &mut self,
        instance_id: i64,
        server_id: String,
        cx: &mut Context<'_, Self>,
    ) {
        self.orbit.waking_instance_id = Some(instance_id);
        self.orbit.notice = Some(format!("Waking Orbit instance #{instance_id}…"));
        self.refresh_settings_orbit_info(cx);
        cx.notify();

        cx.spawn(async move |this, cx| {
            let task = crate::live::RT.spawn(crate::orbit_sync::wake_orbit_instance(instance_id));
            let outcome = match task.await {
                Ok(res) => res,
                Err(err) => Err(conn_desktop::orbit::ProfileError::Unreachable(
                    err.to_string(),
                )),
            };
            let _ = this.update(cx, |app, cx| {
                app.orbit.waking_instance_id = None;
                match outcome {
                    Ok(_) => {
                        app.orbit.notice = Some(format!(
                            "Wake requested for instance #{instance_id}; refreshing fleet…"
                        ));
                        app.sync_orbit_profile(false, cx);
                        // Also kick a pairing attempt if the instance is already registered.
                        let _ = server_id;
                    }
                    Err(err) => {
                        app.orbit.notice =
                            Some(format!("Failed to wake instance #{instance_id}: {err}"));
                    }
                }
                app.refresh_settings_orbit_info(cx);
                cx.notify();
            });
        })
        .detach();
    }

    /// Creates a new Orbit profile (`POST /profiles`), binds this Node to it, and syncs.
    fn create_orbit_profile(&mut self, name: String, cx: &mut Context<'_, Self>) {
        self.orbit.status = crate::orbit_sync::OrbitSyncStatus::Syncing;
        self.orbit.notice = Some(format!("Creating Orbit profile \"{name}\"…"));
        self.refresh_settings_orbit_info(cx);
        cx.spawn(async move |this, cx| {
            let task =
                crate::live::RT.spawn(crate::orbit_sync::create_and_bind_orbit_profile(name));
            let outcome = match task.await {
                Ok(res) => res,
                Err(err) => Err(conn_desktop::orbit::ProfileError::Unreachable(
                    err.to_string(),
                )),
            };
            let _ = this.update(cx, |app, cx| {
                app.orbit.notice = None;
                app.finish_orbit_fetch(outcome, false, cx);
            });
        })
        .detach();
    }

    /// Replaces the bound Orbit profile's appearance and desktop settings with this Mac's values.
    fn force_push_orbit_profile(&mut self, cx: &mut Context<'_, Self>) {
        let Some(profile_id) = self.orbit.active_profile_id() else {
            return;
        };
        let app_doc = if self.orbit.snapshot.prefs.sync_appearance {
            self.resolve_theme(&self.theme_id)
                .map(|(def, _)| self.orbit.build_appearance_document(&def))
        } else {
            None
        };
        let desk_doc = if self.orbit.snapshot.prefs.sync_desktop_settings {
            Some(
                self.orbit
                    .build_desktop_settings_document(self.reduce_transparency),
            )
        } else {
            None
        };
        self.orbit.notice = Some("Sending this device's settings to Orbit profile…".to_owned());
        self.refresh_settings_orbit_info(cx);
        cx.spawn(async move |this, cx| {
            let task = crate::live::RT.spawn(crate::orbit_sync::force_push_profile_sections(
                profile_id, app_doc, desk_doc,
            ));
            let outcome = task.await;
            let _ = this.update(cx, |app, cx| {
                match outcome {
                    Ok(Ok(saved)) => {
                        app.orbit.snapshot.profile_version = saved.version;
                        if let Some(meta) = saved
                            .sections
                            .as_ref()
                            .and_then(|s| s.get(conn_desktop::orbit::APPEARANCE_SECTION))
                            .cloned()
                        {
                            app.orbit.snapshot.appearance_version = meta.version;
                            app.orbit.snapshot.appearance_meta = Some(meta);
                        }
                        if let Some(meta) = saved
                            .sections
                            .as_ref()
                            .and_then(|s| s.get(conn_desktop::orbit::DESKTOP_DEVICE_SECTION))
                            .cloned()
                        {
                            app.orbit.snapshot.desktop_version = meta.version;
                            app.orbit.snapshot.desktop_meta = Some(meta);
                        }
                        app.orbit.persist_snapshot();
                        app.orbit.notice =
                            Some("Updated Orbit profile from this device.".to_owned());
                    }
                    Ok(Err(err)) => {
                        app.orbit.notice = Some(format!("Push failed: {err}"));
                    }
                    Err(err) => {
                        app.orbit.notice = Some(format!("Push failed: {err}"));
                    }
                }
                app.refresh_settings_orbit_info(cx);
                cx.notify();
            });
        })
        .detach();
    }

    /// Saves a local backup of current settings, then pulls the Orbit profile onto this device.
    fn force_pull_orbit_profile(&mut self, cx: &mut Context<'_, Self>) {
        let current_theme = self.resolve_theme(&self.theme_id).map(|(def, _)| def);
        self.orbit
            .backup_local_sections(current_theme.as_ref(), self.reduce_transparency);
        self.orbit.notice = Some("Pulled Orbit profile (previous settings backed up).".to_owned());
        self.sync_orbit_profile(true, cx);
    }

    /// Restores the local backup saved before the last "Use the profile" pull and pushes it.
    fn restore_orbit_backup(&mut self, cx: &mut Context<'_, Self>) {
        let Some((effects, app_doc, desk_doc)) =
            self.orbit.take_backup_restore(self.tokens.appearance)
        else {
            return;
        };
        if let Some(reduce) = effects.reduce_transparency {
            self.apply_reduce_transparency_choice(reduce, false, cx);
        }
        if let Some(theme_id) = effects.theme_id {
            let _ = self.apply_theme_choice(&theme_id, false, cx);
        }
        self.orbit.notice = Some("Previous settings restored.".to_owned());
        self.refresh_settings_orbit_info(cx);
        if let Some(profile_id) = self.orbit.active_profile_id() {
            cx.spawn(async move |this, cx| {
                let _ = crate::live::RT
                    .spawn(crate::orbit_sync::force_push_profile_sections(
                        profile_id, app_doc, desk_doc,
                    ))
                    .await;
                let _ = this.update(cx, |app, cx| {
                    app.sync_orbit_profile(false, cx);
                });
            })
            .detach();
        }
        cx.notify();
    }

    fn scheduled_task_projects(&self) -> Vec<crate::settings::ScheduledTaskProjectOption> {
        self.shell
            .projects
            .iter()
            .filter(|p| p.archived_at.is_none())
            .map(|p| crate::settings::ScheduledTaskProjectOption {
                id: p.id.clone(),
                name: p.title.clone(),
            })
            .collect()
    }

    fn default_scheduled_task_model(&self) -> (Option<String>, String) {
        if let Some(thread_id) = &self.layout.selected_thread_id
            && let Some(thread) = self.shell.threads.iter().find(|t| &t.id == thread_id)
        {
            let instance = conn_state::extract_model_instance(&thread.model_selection);
            let slug = conn_state::extract_model_slug(&thread.model_selection);
            if !slug.is_empty() {
                return (instance, slug);
            }
        }
        (
            Some("claudeAgent".to_owned()),
            "claude-sonnet-4-6".to_owned(),
        )
    }

    fn refresh_settings_orbit_info(&self, cx: &mut Context<'_, Self>) {
        if let Some(modal) = &self.settings_modal {
            let connection = crate::settings::SettingsConnectionInfo {
                server_label: self.server_label.clone(),
                server_url: self.server_url.clone(),
                status: self.status.clone(),
            };
            let live_connection = self.connection.clone();
            let projects = self.scheduled_task_projects();
            let info = self.orbit.settings_info(self.server_url.as_deref());
            let custom = self.orbit.custom_themes.clone();
            modal.update(cx, |m, cx| {
                m.set_orbit_state(connection, live_connection, projects, info, &custom, cx);
            });
        }
    }
    /// Switches the selected thread's (or active draft's) runtime permission mode
    /// (`thread.runtime-mode.set`).
    fn set_runtime_mode(&mut self, mode: &str, cx: &mut Context<'_, Self>) {
        if let Some(draft) = &mut self.draft {
            draft.runtime_mode = mode.to_owned();
            self.sync_chat(cx);
            cx.notify();
            return;
        }
        let (Some(connection), Some(thread_id)) = (
            self.connection.clone(),
            self.layout.selected_thread_id.clone(),
        ) else {
            return;
        };
        let Ok(cmd) = crate::commands::set_runtime_mode(&thread_id, mode) else {
            return;
        };
        cx.spawn(async move |_, _| {
            if let Err(e) = connection.dispatch_command(cmd).await {
                eprintln!("runtime mode: dispatchCommand failed: {e}");
            }
        })
        .detach();
    }

    /// Switches the selected thread's (or active draft's) interaction mode
    /// (`thread.interaction-mode.set`).
    fn set_interaction_mode(&mut self, mode: &str, cx: &mut Context<'_, Self>) {
        if let Some(draft) = &mut self.draft {
            draft.interaction_mode = mode.to_owned();
            self.sync_chat(cx);
            cx.notify();
            return;
        }
        let (Some(connection), Some(thread_id)) = (
            self.connection.clone(),
            self.layout.selected_thread_id.clone(),
        ) else {
            return;
        };
        let Ok(cmd) = crate::commands::set_interaction_mode(&thread_id, mode) else {
            return;
        };
        cx.spawn(async move |_, _| {
            if let Err(e) = connection.dispatch_command(cmd).await {
                eprintln!("interaction mode: dispatchCommand failed: {e}");
            }
        })
        .detach();
    }

    /// Executes a built-in `/` slash command selected in the composer menu.
    fn handle_slash_command(&mut self, command: &str, cx: &mut Context<'_, Self>) {
        match command {
            "plan" => {
                if let Some(draft) = &self.draft {
                    let next = if draft.interaction_mode == "plan" {
                        "default"
                    } else {
                        "plan"
                    };
                    self.set_interaction_mode(next, cx);
                    return;
                }
                let Some(thread_id) = self.layout.selected_thread_id.as_deref() else {
                    return;
                };
                let next_mode = self
                    .shell
                    .find_thread(thread_id)
                    .map(|t| conn_contract::to_json(&t.interaction_mode))
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .map(|current| if current == "plan" { "default" } else { "plan" })
                    .unwrap_or("plan");
                self.set_interaction_mode(next_mode, cx);
            }
            "settle" => {
                self.toggle_selected_thread_settled(cx);
            }
            _ => {
                // Other slash commands (`/clear`, `/compact`, `/review`, `/status`, `/usage`)
                // remain in the composer draft so the user can add arguments and press Enter.
            }
        }
    }

    /// Toggles the selected thread's settled state (`thread.settle` / `thread.unsettle`).
    fn toggle_selected_thread_settled(&mut self, cx: &mut Context<'_, Self>) {
        let Some(thread_id) = self.layout.selected_thread_id.clone() else {
            return;
        };
        let is_settled = self
            .shell
            .find_thread(&thread_id)
            .is_some_and(ShellState::is_settled);
        self.settle_thread(thread_id, !is_settled, cx);
    }

    /// Toggles Reduce Transparency across the shell, matching Conn's
    /// `@media (prefers-reduced-transparency: reduce)` (`--shell-fill: var(--sidebar);
    /// --shell-inner-fill: var(--shell-card);`).
    fn set_reduce_transparency(&mut self, enabled: bool, cx: &mut Context<'_, Self>) {
        self.apply_reduce_transparency_choice(enabled, true, cx);
    }

    fn apply_reduce_transparency_choice(
        &mut self,
        enabled: bool,
        push_to_orbit: bool,
        cx: &mut Context<'_, Self>,
    ) {
        if self.reduce_transparency == enabled {
            return;
        }
        self.reduce_transparency = enabled;
        let theme_id = self.theme_id.clone();
        if let Some((_, tokens)) = self.resolve_theme(&theme_id) {
            self.set_tokens(tokens, cx);
        } else {
            cx.notify();
        }
        if push_to_orbit {
            self.push_orbit_desktop_settings(enabled, cx);
        }
    }

    /// Replaces the active theme tokens and updates `gpui-kit`'s global theme.
    pub(crate) fn set_tokens(&mut self, mut tokens: Tokens, cx: &mut Context<'_, Self>) {
        if self.reduce_transparency {
            tokens.shell_fill = tokens.sidebar;
            tokens.shell_inner_fill = tokens.shell_card;
        }
        apply_kit_theme(&tokens, cx);
        crate::vibrancy::sync_appearance(tokens.appearance);
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

/// Renders of the root view, for `CONN_GPUI_FRAME_LOG=1` (frames actually drawn).
static RENDERS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Logs root renders per second to stderr when `CONN_GPUI_FRAME_LOG` is set.
pub(crate) fn start_frame_log(cx: &mut App) {
    if std::env::var_os("CONN_GPUI_FRAME_LOG").is_none() {
        return;
    }
    cx.spawn(async move |cx| {
        let mut last = 0;
        loop {
            cx.background_executor()
                .timer(std::time::Duration::from_secs(1))
                .await;
            let now = RENDERS.load(std::sync::atomic::Ordering::Relaxed);
            if now != last {
                eprintln!("frames: {} renders in the last second", now - last);
                last = now;
            }
        }
    })
    .detach();
}

impl Render for ConnApp {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        RENDERS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut root = div()
            .id("conn-shell-root")
            .a11y_group("shell.root", "Conn workspace")
            .track_focus(&self.focus_handle)
            .capture_key_down(
                cx.listener(|app, event: &gpui_kit::KeyDownEvent, _window, cx| {
                    if std::env::var_os("CONN_GPUI_FRAME_LOG").is_some() {
                        eprintln!(
                            "key: {:?} {:?}",
                            event.keystroke.modifiers, event.keystroke.key
                        );
                    }
                    if app.handle_add_menu_key(event, cx) {
                        cx.stop_propagation();
                    }
                }),
            )
            .on_mouse_down(
                gpui_kit::MouseButton::Left,
                cx.listener(|app, _, _window, cx| {
                    // A click outside open header popovers closes them (their triggers and items
                    // stop propagation).
                    let mut changed = false;
                    if app.right_panel_add_menu_open {
                        app.right_panel_add_menu_open = false;
                        changed = true;
                    }
                    if app.sidebar_filter_menu_open {
                        app.sidebar_filter_menu_open = false;
                        changed = true;
                    }
                    if changed {
                        cx.notify();
                    }
                }),
            )
            .on_action(cx.listener(|app, _: &ToggleSidebar, _window, cx| {
                app.toggle_sidebar(cx);
            }))
            .on_action(cx.listener(|app, _: &ToggleRightPanel, _window, cx| {
                app.toggle_right_panel(cx);
            }))
            .on_action(cx.listener(|app, _: &NewThread, window, cx| {
                app.start_new_thread(None, Some(window), cx);
            }))
            .on_action(
                cx.listener(|app, _: &crate::palette::OpenCommandPalette, window, cx| {
                    if std::env::var_os("CONN_GPUI_FRAME_LOG").is_some() {
                        eprintln!("action: open command palette");
                    }
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
                    &self.orbit.workspaces,
                    self.active_workspace.as_deref(),
                    &self.tokens,
                    &self.geometry,
                    cx,
                ))
                .child(render_thread_sidebar(
                    &self.shell,
                    &self.layout,
                    &self.orbit.workspaces,
                    self.active_workspace.as_deref(),
                    self.draft.as_ref().map(|d| d.project_id.as_str()),
                    &self.collapsed_projects,
                    &self.sidebar_search_input,
                    self.renaming_thread_id.as_deref(),
                    &self.rename_input,
                    self.sidebar_filter_menu_open,
                    &self.tokens,
                    &self.geometry,
                    cx,
                ))
                .child(self.render_seam(false, cx));
        }

        let maximized = self.layout.right_panel_open && self.right_panel_maximized;
        if !maximized {
            root = root.child(self.render_chat_column(cx));
        }

        if self.layout.right_panel_open {
            if !maximized {
                root = root.child(self.render_seam(true, cx));
            }
            root = root.child(self.render_right_panel_column(cx));
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

fn default_device_name() -> String {
    std::env::var("USER").unwrap_or_else(|_| "Mac".to_owned())
}
