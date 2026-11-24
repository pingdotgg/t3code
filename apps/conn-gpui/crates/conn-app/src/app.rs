//! Root [`ConnApp`] GPUI view holding shell state, layout state, and theme tokens.

use std::collections::{HashMap, HashSet};

use conn_client::{ClientEvent, Connection, ConnectionStatus, ServerConfig};
use conn_state::{
    LayoutState, PanelOwner, PanelSurface, RightPanelTab, RightPanelTabs, ShellState, ThreadPanel,
    ThreadPanels, ThreadState,
};
use conn_theme::{ShellGeometry, Tokens};
use gpui_kit::{
    App, AppContext as _, Context, Entity, FocusHandle, Focusable, InteractiveElement as _,
    IntoElement, KeyBinding, ParentElement as _, Render, Styled as _, Window, actions, div, px,
};

use crate::a11y::ConnA11yExt as _;
use crate::drafts::{DraftBook, DraftContent, DraftThreadState, new_draft_id, now_ms};
use crate::fixture::demo_shell_state;
use crate::header::details_card::{
    DetailsCardProps, DetailsCopyTarget, EditorTarget, THREAD_DETAILS_CARD_GAP_PX,
    ThreadDetailsState, render_thread_details_card, thread_cwd,
};
use crate::header::{ChatHeaderProps, render_chat_header};
use crate::shell::{CardJoin, inset_card, two_tone_divider};
use crate::sidebar::drafts::{DraftRowView, DraftSidebar, UndoNotice};
use crate::sidebar::hover_card_state::ThreadHoverState;
use crate::sidebar::rail::render_workspace_rail;
use crate::sidebar::thread_list::{SidebarMarks, ThreadHoverView, render_thread_sidebar};
use crate::sidebar::thread_menu::{
    DraftMenuState, MenuCursor, ThreadMenuAction, ThreadMenuAnchor, ThreadMenuState,
    build_bulk_menu_items, build_draft_action_menu_items, build_thread_action_menu_items,
    render_thread_action_menu,
};
use crate::sidebar::tree::SidebarTree;
use crate::theme::{apply_kit_theme, hsla};
use gpui_kit::prelude::FluentBuilder as _;

mod child_approvals;
mod linked;
mod offline;
mod rail_workspaces;
mod sidebar_keys;
mod sidebar_more;
mod thread_panels;

pub(crate) use self::sidebar_more::PressMode;

actions!(
    conn_app,
    [
        ToggleSidebar,
        ToggleRightPanel,
        NewThread,
        ToggleTerminal,
        NewRightPanelSurface
    ]
);

/// Registers global shell keyboard shortcuts (`Cmd+B`, `Cmd+Alt+B` and `Cmd+J`).
pub(crate) fn register_keybindings(cx: &mut App) {
    crate::palette::register_keybindings(cx);
    crate::settings::register_keybindings(cx);
    cx.bind_keys([
        KeyBinding::new("cmd-b", ToggleSidebar, None),
        KeyBinding::new("cmd-alt-b", ToggleRightPanel, None),
        KeyBinding::new("cmd-n", NewThread, None),
        // `terminal.toggle` is `mod+j` in Conn's default keybindings.
        KeyBinding::new("cmd-j", ToggleTerminal, None),
        // `rightPanel.new` (`mod+t`, `rightPanelOpen && !terminalFocus`) opens the `+` menu.
        KeyBinding::new("cmd-t", NewRightPanelSurface, None),
    ]);
}

/// The terminal drawer's default height (`DEFAULT_THREAD_TERMINAL_HEIGHT`).
const TERMINAL_DRAWER_DEFAULT_PX: f32 = 280.0;
/// `MIN_DRAWER_HEIGHT` in `ThreadTerminalDrawer.tsx`.
const TERMINAL_DRAWER_MIN_PX: f32 = 180.0;
/// `MAX_DRAWER_HEIGHT_RATIO` in `ThreadTerminalDrawer.tsx`.
const TERMINAL_DRAWER_MAX_RATIO: f32 = 0.75;

/// The terminal drawer's height kept within Conn's bounds for a window `viewport_h` tall.
fn clamp_terminal_drawer_height(height: f32, viewport_h: f32) -> f32 {
    let max = (viewport_h * TERMINAL_DRAWER_MAX_RATIO).max(TERMINAL_DRAWER_MIN_PX);
    height.clamp(TERMINAL_DRAWER_MIN_PX, max)
}

/// A panel seam being dragged: which side, where the drag started, and the width then.
#[derive(Clone, Copy, Debug, PartialEq)]
enum SeamDrag {
    Sidebar {
        from_x: f32,
        start: f32,
    },
    RightPanel {
        from_x: f32,
        start: f32,
    },
    /// The terminal drawer's top edge: where the drag started, and the height then.
    TerminalDrawer {
        from_y: f32,
        start: f32,
    },
}

/// A discarded draft, kept for `Undo`.
enum DiscardedDraft {
    /// A new-thread draft.
    New {
        session: DraftThreadState,
        content: Option<DraftContent>,
        /// The project key that opened it, to take its slot back when that is still free.
        project_key: Option<String>,
    },
    /// A started thread's unsent input.
    Thread {
        thread_id: String,
        content: DraftContent,
    },
}

/// What a thread was before a settle, for the undo.
fn settle_facts(thread: &conn_state::ThreadShell) -> conn_state::SettledThreadFacts<'_> {
    fn text(value: &Option<Option<String>>) -> Option<&str> {
        value.as_ref().and_then(Option::as_deref)
    }
    conn_state::SettledThreadFacts {
        pinned: text(&thread.pinned_at).is_some(),
        pin_order_key: text(&thread.pin_order_key),
        active_order_key: text(&thread.active_order_key),
        unsettled_at: text(&thread.unsettled_at),
        snoozed_until: text(&thread.snoozed_until),
    }
}

/// What a thread's undo puts back, and what else ends it (`ThreadUndo` claim kinds): a newer
/// action of the same kind on the thread replaces its entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ThreadUndoKind {
    Settle,
    /// An unpin.
    Pin,
}

impl ThreadUndoKind {
    /// What the notice says of it.
    fn action(self) -> conn_state::UndoAction {
        match self {
            Self::Settle => conn_state::UndoAction::Settled,
            Self::Pin => conn_state::UndoAction::Unpinned,
        }
    }
}

/// Where the open thread goes when it leaves the active list (`planForwardNavigation`).
enum ForwardNavigation {
    /// The next thread.
    Thread(String),
    /// A new thread in this project, when no thread is left.
    NewThread(Option<String>),
}

/// What `Undo` and `⌘Z` bring back.
enum UndoEntry {
    /// A discarded draft or thread input.
    Draft(DiscardedDraft),
    /// A settled or unpinned thread, and the commands that put it back as it was.
    Thread {
        thread_id: String,
        kind: ThreadUndoKind,
        plan: Vec<conn_state::SettleUndoStep>,
    },
}

/// `orchestration.launchThread` `workspaceStrategy` for a draft.
fn draft_workspace_strategy(draft: &DraftThreadState) -> serde_json::Value {
    if let Some(path) = &draft.worktree_path {
        serde_json::json!({ "type": "existing_worktree", "worktreePath": path, "branch": draft.branch })
    } else if draft.use_worktree {
        serde_json::json!({
            "type": "worktree",
            "baseRef": draft.branch.as_deref().unwrap_or("HEAD"),
            "startFromOrigin": draft.start_from_origin,
        })
    } else {
        match &draft.branch {
            Some(branch) => serde_json::json!({ "type": "root", "branch": branch }),
            None => serde_json::json!({ "type": "root" }),
        }
    }
}

/// Why an agent's panel request reached Conn before the primary server said who it is.
pub(crate) const PRIMARY_NOT_READY: &str =
    "Conn is still connecting to this server, so it did not open the panel. Try again in a moment.";

/// The connection an agent's panel request came from.
pub(super) enum PanelOrigin {
    Primary,
    Linked(String),
}

/// Where an agent's panel request is answered.
pub(super) enum PanelReply {
    /// `panels.respond` on the connection it came from.
    Server(Connection),
    #[cfg(test)]
    Test(tokio::sync::oneshot::Sender<conn_contract::source::DesktopPanelResponse>),
}

impl PanelReply {
    async fn send(self, response: conn_contract::source::DesktopPanelResponse) {
        match self {
            Self::Server(connection) => {
                let _ = crate::live::RT
                    .spawn(async move {
                        let _ = connection
                            .call::<conn_contract::source::DesktopPanelResponse, ()>(
                                "panels.respond",
                                &response,
                            )
                            .await;
                    })
                    .await;
            }
            #[cfg(test)]
            Self::Test(tx) => {
                let _ = tx.send(response);
            }
        }
    }
}

struct FilesSubscription {
    thread: String,
    connection: Connection,
}

/// Root view of the Conn native desktop shell.
pub(crate) struct ConnApp {
    tokens: Tokens,
    geometry: ShellGeometry,
    offline: offline::Offline,
    shell: ShellState,
    layout: LayoutState,
    active_workspace: Option<String>,
    /// What the thread sidebar remembers and does besides its lists: the Settled shelf, the message
    /// search, dragging rows and sweeping runs of them.
    sidebar: sidebar_more::SidebarState,
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
    /// `server.getConfig` `scratchWorkspaceRoot`; `None` hides `or start without a project`.
    scratch_workspace_root: Option<String>,
    /// Project id returned by `projects.ensureScratch`, before the shell lists it.
    scratch_project_id: Option<String>,
    /// The new-thread drafts behind the open one, and which draft each project opens. Their text
    /// and attachments wait in the composer's draft store, under the draft's id.
    drafts: DraftBook,
    /// The discards and settles `Undo` and `⌘Z` bring back, until their notice expires.
    discards: conn_state::DiscardUndo<UndoEntry>,
    /// The search result the arrow keys highlighted, by thread id (`searchHighlightKey`); the
    /// first result while none, or when its thread left the results.
    sidebar_search_highlight: Option<String>,
    /// `⌘` has been held long enough for the rows to show their jump numbers
    /// (`useThreadJumpHintsVisible`).
    jump_hints: bool,
    /// Counts the `⌘` presses, so a timer that outlived its press does nothing.
    jump_hint_generation: u64,
    /// The threads picked with `⌘`-click and `Shift`-click for a bulk action.
    thread_selection: conn_state::ThreadSelection,
    /// A thread opened, so its row scrolls into view once the list has drawn it.
    reveal_open_row: bool,
    /// Why the last undo could not put the input back, until its notice expires.
    discard_failure: Option<&'static str>,
    discard_failure_generation: u64,
    /// The notice's `Undo` button.
    undo_focus: FocusHandle,
    /// The thread sidebar's rows the keyboard can reach.
    sidebar_tree: SidebarTree,
    /// The open thread or draft menu takes the keyboard while it is open.
    thread_menu_focus: FocusHandle,
    thread_menu_focus_pending: bool,
    /// What had the keyboard when the menu opened; it gets it back when the menu closes.
    thread_menu_return_focus: Option<FocusHandle>,
    /// The closed menu has handed the keyboard back, and it has not landed yet.
    thread_menu_returning: bool,
    /// Sees keystrokes before key bindings do (`intercept_keystroke`).
    _keystroke_interceptor: gpui_kit::Subscription,
    /// The interceptor used the keystroke being dispatched; the root's key handler skips it.
    keystroke_consumed: bool,
    /// Where drafts are kept across restarts; `None` keeps them in memory only.
    drafts_path: Option<std::path::PathBuf>,
    /// The drafts file as last written, so an unchanged state is not written again.
    saved_drafts_json: Option<String>,
    /// Approval requests with a `runtime-request.respond` in flight (`respondingRequestIds`).
    responding_approvals: HashSet<String>,
    /// Right panel tabs the user has open, in order, and the active one (Conn's
    /// `rightPanelStore`). Any number of browser tabs; one of every other kind.
    right_panel_tabs: RightPanelTabs,
    /// The other threads' right panels; `right_panel_tabs` and `layout.right_panel_open` hold
    /// the shown thread's (`rightPanelStore.byThreadKey`).
    thread_panels: ThreadPanels,
    /// Where every thread's panel is saved, and its pending and last writes.
    panel_saves: thread_panels::PanelSaves,
    /// The primary server's environment id: the one saved with the layout at launch, then the
    /// one its config snapshot names. Panel owners on the primary use it.
    primary_environment: Option<String>,
    /// The connected primary confirmed `primary_environment` since it (re)connected. Until
    /// then an agent's panel request is refused: its thread could be another server's.
    primary_confirmed: bool,
    right_panel_add_menu_open: bool,
    right_panel_maximized: bool,
    /// The terminal drawer under the chat is open, and its height.
    terminal_drawer_open: bool,
    terminal_drawer_height: f32,
    seam_drag: Option<SeamDrag>,
    command_palette: Option<Entity<crate::palette::CommandPalette>>,
    settings_modal: Option<Entity<crate::settings::SettingsModal>>,
    /// The live `subscribeServerConfig` projection: the provider catalog the composer, the model
    /// picker, the status banner and the Providers settings page read.
    server_config: std::sync::Arc<conn_state::providers::ServerConfigState>,
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
    /// The inline rename edits the chat header title (else the sidebar row).
    rename_in_header: bool,
    /// Open Thread Actions menu (sidebar right-click or header title).
    thread_menu: Option<ThreadMenuAnchor>,
    /// Open workspace menu (right-click on a rail tile).
    rail_menu: Option<crate::sidebar::rail::RailMenuAnchor>,
    /// The workspace editor (`WorkspaceDialog`), open from the rail's `+` or a tile's `Edit…`.
    workspace_editor: Option<Entity<crate::workspace_editor::WorkspaceEditor>>,
    /// The workspace the editor edits; none while it creates one.
    workspace_editor_target: Option<String>,
    /// Each workspace's badge image, decoded once from its data URL.
    workspace_images: HashMap<String, (String, Option<std::sync::Arc<gpui_kit::Image>>)>,
    /// A workspace tile held in the rail, and where the tiles were painted.
    rail_gesture: crate::sidebar::rail::RailGesture,
    /// Bumped to cancel a pending `Copy` submenu hover-intent close.
    thread_menu_copy_close_gen: u64,
    /// Bumped to cancel a pending header-title menu open (double-click renames instead).
    header_menu_generation: u64,
    /// Top-right Thread Details card.
    thread_details: ThreadDetailsState,
    /// Sidebar thread hover flyout (`ThreadHoverCard`).
    pub(crate) thread_hover: ThreadHoverState,
    /// Ticks relative times and live elapsed labels (`useNowSecond` / `useNowMinute`).
    _sidebar_clock: Option<gpui_kit::Task<()>>,
    /// Whether the sidebar project-scope filter popover is open.
    sidebar_filter_menu_open: bool,
    /// When true, replaces translucent shell fills with opaque `sidebar`/`shell_card`.
    reduce_transparency: bool,
    persist_composer_context_strip: bool,
    server_url: Option<String>,
    server_label: Option<String>,
    /// Monotonic counter incremented on every live server switch so stale event pumps stop cleanly.
    connection_gen: u64,
    /// Orbit Gateway Nodes/Instances, profile, workspace, theme, and desktop settings sync state.
    orbit: crate::orbit_sync::OrbitSyncState,
    /// Thread id requested via `conn://thread/...` or control socket while switching servers.
    pending_open_thread: Option<String>,
    /// Orbit environments listed beside the primary one (`app/linked.rs`).
    linked: linked::LinkedEnvironments,
    /// Child threads subscribed for their approvals (`app/child_approvals.rs`).
    child_approvals: child_approvals::ChildApprovals,
    /// Live control socket server handle (dropped on app exit).
    _control_server: Option<conn_desktop::control::ControlServerHandle>,
    /// Background task draining `conn://` URLs and Unix control socket requests.
    _activation_task: Option<gpui_kit::Task<()>>,
    /// Thread id currently subscribed via `orchestration.subscribeThread` on `self.connection`.
    subscribed_thread_id: Option<String>,
    /// Thread opened at this instant, for `CONN_GPUI_PERF_LOG` stage timings.
    perf_open: Option<(String, std::time::Instant)>,
    /// `perf_open` not yet handed to the chat view (which logs the first paint).
    perf_open_pending_chat: bool,
    /// Project id currently subscribed to `annotations.subscribe` on `self.connection`.
    subscribed_annotation_project: Option<String>,
    files_subscription: Option<FilesSubscription>,
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
        // The widths the user dragged the panels to last time (`useResizableWidth`).
        let sidebar_state = sidebar_more::SidebarState::load();
        let (saved_sidebar_width, saved_panel_width) = sidebar_state.saved_widths();
        if let Some(width) = saved_sidebar_width {
            layout.set_sidebar_width(width);
        }
        if let Some(width) = saved_panel_width {
            layout.set_right_panel_width(width);
        }
        let env_pinned_server = crate::live::server_config_from_env().is_some();
        let server_url = server.as_ref().map(|s| s.config.http_base_url.to_string());
        let server_label = server.as_ref().and_then(|s| s.label.clone());
        let initial_orbit_server_id = server.as_ref().and_then(|s| s.orbit_server_id.clone());

        let (shell, connection) = match server {
            Some(startup) => {
                let (connection, events) =
                    Self::start_connection(startup.config, default_device_name());
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
                crate::chat::ChatEvent::Send {
                    text,
                    attachments,
                    dispatch,
                    held_draft: None,
                } => {
                    app.send_prompt_with_attachments(
                        text.clone(),
                        attachments.clone(),
                        *dispatch,
                        Some(window),
                        cx,
                    );
                }
                crate::chat::ChatEvent::Send {
                    text,
                    attachments,
                    dispatch,
                    held_draft: Some(held),
                } => {
                    app.send_over_approvals(
                        text.clone(),
                        attachments.clone(),
                        *dispatch,
                        held.clone(),
                        window,
                        cx,
                    );
                }
                crate::chat::ChatEvent::Resume => {
                    // `useComposerResume`: continue the interrupted run.
                    app.send_prompt("Continue where you left off.".to_owned(), cx);
                }
                crate::chat::ChatEvent::ImplementPlanInNewThread { text } => {
                    app.start_new_thread(None, Some(window), cx);
                    if let Some(draft) = app.draft.as_mut() {
                        draft.interaction_mode = "default".to_owned();
                    }
                    app.send_prompt_with_attachments(
                        text.clone(),
                        Vec::new(),
                        crate::chat::SendDispatch::Auto,
                        Some(window),
                        cx,
                    );
                }
                crate::chat::ChatEvent::Stop => app.stop_selected(cx),
                crate::chat::ChatEvent::Approval { entry_id, decision } => {
                    app.respond_approval(entry_id, decision, cx);
                }
                crate::chat::ChatEvent::ChildApproval {
                    thread_id,
                    request_id,
                    decision,
                } => {
                    app.respond_child_approval(thread_id, request_id, decision, cx);
                }
                crate::chat::ChatEvent::ModelSelected {
                    instance_id,
                    model,
                    options,
                } => {
                    app.select_model(instance_id, model, options.as_ref(), cx);
                }
                crate::chat::ChatEvent::OpenTurnDiff {
                    app_run_ordinal,
                    file_path,
                    ..
                } => {
                    let (turn, file) = (*app_run_ordinal, file_path.clone());
                    app.right_panel
                        .update(cx, |panel, cx| panel.open_turn_diff(turn, file, cx));
                    app.select_right_panel_tab(RightPanelTab::Diff, cx);
                }
                crate::chat::ChatEvent::OpenTask { task_id } => {
                    let task_id = *task_id;
                    app.right_panel
                        .update(cx, |panel, cx| panel.open_task(task_id, cx));
                    app.select_right_panel_tab(RightPanelTab::Tasks, cx);
                }
                crate::chat::ChatEvent::OpenThread {
                    thread_id,
                    environment_id,
                } => {
                    if let Some(environment) = environment_id {
                        app.open_remote_child(environment, thread_id, cx);
                    } else {
                        app.select_thread(thread_id.clone(), cx);
                    }
                }
                crate::chat::ChatEvent::ForkFromRun { run_id } => {
                    app.fork_selected_from_run(run_id, cx);
                }
                crate::chat::ChatEvent::OpenFile(location) => {
                    app.show_source_location(location, cx)
                }
                crate::chat::ChatEvent::OpenInBrowser(url) => {
                    app.open_browser_tab(url.clone(), false, cx);
                }
                crate::chat::ChatEvent::RuntimeModeSelected(mode) => {
                    app.set_runtime_mode(mode, cx);
                }
                crate::chat::ChatEvent::InteractionModeSelected(mode) => {
                    app.set_interaction_mode(mode, cx);
                }
                crate::chat::ChatEvent::Branch(action) => {
                    app.handle_branch_action(action.clone(), cx)
                }
                crate::chat::ChatEvent::DraftProjectSelected(project_id) => {
                    app.set_draft_project(project_id.clone(), cx);
                }
                crate::chat::ChatEvent::DraftStartScratch => app.start_draft_scratch(cx),
                crate::chat::ChatEvent::DraftAddProject => app.add_project_via_picker(window, cx),
                crate::chat::ChatEvent::OpenProviderSetup(instance_id) => {
                    app.open_provider_setup(instance_id, window, cx);
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
                crate::chat::ChatEvent::JumpToPrompt(id) => app.resolve_prompt(id, cx),
                crate::chat::ChatEvent::ReturnToLatest => {
                    app.sync_chat(cx);
                    app.chat.update(cx, |chat, cx| chat.scroll_to_latest(cx));
                }
                crate::chat::ChatEvent::LoadEarlierHistory => {
                    app.load_earlier_history(cx);
                }
                crate::chat::ChatEvent::PromoteQueuedMessage { run_id } => {
                    app.promote_queued_message(run_id, cx);
                }
                crate::chat::ChatEvent::CancelQueuedMessage { run_id } => {
                    app.cancel_queued_message(run_id, cx);
                }
                crate::chat::ChatEvent::EditQueuedMessage {
                    run_id,
                    text,
                    attachments,
                } => {
                    app.edit_queued_message(run_id, text, attachments.as_deref(), cx);
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
        cx.subscribe_in(
            &right_panel,
            window,
            |app, _, event: &crate::panels::RightPanelEvent, window, cx| match event {
                crate::panels::RightPanelEvent::DisplayedFileChanged => cx.notify(),
                crate::panels::RightPanelEvent::Definition(location) => {
                    app.show_source_location(location, cx)
                }
                crate::panels::RightPanelEvent::AttachSource(source) => {
                    app.chat
                        .update(cx, |chat, cx| chat.attach_source(source, window, cx));
                }
                crate::panels::RightPanelEvent::OpenFile(path) => {
                    app.select_right_panel_surface(PanelSurface::File(path.clone()), cx);
                }
                crate::panels::RightPanelEvent::OpenTab(tab) => {
                    app.select_right_panel_tab(*tab, cx);
                }
                crate::panels::RightPanelEvent::InsertMention(mention) => {
                    app.chat
                        .update(cx, |chat, cx| chat.insert_mention(mention, window, cx));
                }
                crate::panels::RightPanelEvent::SendPrompt(prompt) => {
                    app.send_prompt(prompt.clone(), cx);
                }
                crate::panels::RightPanelEvent::Annotation(action) => {
                    app.handle_annotation_action(action.clone(), cx);
                }
                crate::panels::RightPanelEvent::OpenBrowserTab { url, background } => {
                    app.open_browser_tab(url.clone(), *background, cx);
                }
                crate::panels::RightPanelEvent::BrowserTitleChanged => cx.notify(),
                // A page navigates rarely; the save writes only when the layout changed.
                crate::panels::RightPanelEvent::BrowserAddressChanged => {
                    app.save_thread_panels(cx);
                }
            },
        )
        .detach();

        let sidebar_search_input = cx.new(|cx| {
            gpui_kit::component::input::InputState::new(window, cx).placeholder("Search")
        });
        let sidebar_search_sub = cx.subscribe(
            &sidebar_search_input,
            |app, _, event: &gpui_kit::component::input::InputEvent, cx| {
                if matches!(event, gpui_kit::component::input::InputEvent::Change) {
                    // A new query starts at the top (`onSearchQueryChange`).
                    app.sidebar_search_highlight = None;
                    app.sidebar_search_changed(cx);
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
                    app.commit_thread_rename(cx);
                }
                _ => {}
            },
        );

        let orbit = crate::orbit_sync::OrbitSyncState {
            active_server_id: initial_orbit_server_id,
            ..Default::default()
        };
        let this = cx.entity().downgrade();
        let keystroke_interceptor = cx.intercept_keystrokes(move |event, window, cx| {
            let _ = this.update(cx, |app, cx| app.intercept_keystroke(event, window, cx));
        });
        let offline = if connection.is_some() {
            offline::Offline::new()
        } else {
            offline::Offline::default()
        };
        let mut app = Self {
            tokens,
            geometry: ShellGeometry::default(),
            shell,
            layout,
            active_workspace: rail_workspaces::saved_active_workspace(&orbit.workspaces),
            sidebar: sidebar_state,
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
            scratch_workspace_root: None,
            scratch_project_id: None,
            drafts: DraftBook::default(),
            discards: conn_state::DiscardUndo::default(),
            sidebar_search_highlight: None,
            jump_hints: false,
            jump_hint_generation: 0,
            thread_selection: conn_state::ThreadSelection::default(),
            reveal_open_row: false,
            discard_failure: None,
            discard_failure_generation: 0,
            undo_focus: cx.focus_handle().tab_index(0).tab_stop(true),
            sidebar_tree: SidebarTree::new(),
            thread_menu_focus: cx.focus_handle(),
            thread_menu_focus_pending: false,
            thread_menu_return_focus: None,
            thread_menu_returning: false,
            _keystroke_interceptor: keystroke_interceptor,
            keystroke_consumed: false,
            drafts_path: crate::drafts::drafts_file_path(),
            saved_drafts_json: None,
            responding_approvals: HashSet::new(),
            // No tab until one is picked: opening the panel shows the surface launcher.
            right_panel_tabs: RightPanelTabs::default(),
            thread_panels: ThreadPanels::default(),
            panel_saves: thread_panels::PanelSaves::new(thread_panels::thread_panels_file_path()),
            primary_environment: None,
            primary_confirmed: false,
            right_panel_add_menu_open: false,
            right_panel_maximized: false,
            terminal_drawer_open: false,
            terminal_drawer_height: TERMINAL_DRAWER_DEFAULT_PX,
            seam_drag: None,
            command_palette: None,
            settings_modal: None,
            server_config: std::sync::Arc::default(),
            overlay_subscriptions: Vec::new(),
            focus_before_overlay: None,
            sidebar_search_input,
            _sidebar_search_sub: sidebar_search_sub,
            renaming_thread_id: None,
            rename_input,
            _rename_sub: rename_sub,
            rename_in_header: false,
            thread_menu: None,
            rail_menu: None,
            workspace_editor: None,
            workspace_editor_target: None,
            workspace_images: HashMap::new(),
            rail_gesture: crate::sidebar::rail::RailGesture::default(),
            thread_menu_copy_close_gen: 0,
            header_menu_generation: 0,
            thread_details: ThreadDetailsState::default(),
            _sidebar_clock: None,
            sidebar_filter_menu_open: false,
            reduce_transparency: false,
            persist_composer_context_strip: false,
            server_url,
            server_label,
            connection_gen: 1,
            orbit,
            pending_open_thread: None,
            offline,
            linked: linked::LinkedEnvironments::load(),
            child_approvals: child_approvals::ChildApprovals::default(),
            _control_server: None,
            _activation_task: None,
            subscribed_thread_id: None,
            thread_hover: ThreadHoverState::default(),
            perf_open: None,
            perf_open_pending_chat: false,
            subscribed_annotation_project: None,
            files_subscription: None,
            annotations: Vec::new(),
            annotation_watching_threads: HashSet::new(),
            annotation_last_sent: HashMap::new(),
        };
        app.restore_offline_shell();
        app.expire_offline(cx);
        app.restore_saved_drafts(cx);
        app.restore_thread_panels(cx);
        // The write in flight finishes, and the latest layout follows if it differs.
        cx.on_app_quit(|app, cx| app.thread_panels_on_quit(cx))
            .detach();
        app.sync_chat(cx);
        app.start_sidebar_clock(cx);
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
        let persist_composer_context_strip = self.persist_composer_context_strip;
        let live_connection = self.connection.clone();
        let projects = self.scheduled_task_projects();
        let default_model = self.default_scheduled_task_model();
        let modal = cx.new(|cx| {
            let mut m = SettingsModal::new(
                theme_id,
                tokens,
                reduce_transparency,
                persist_composer_context_strip,
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
                SettingsEvent::PersistComposerContextStrip(enabled) => {
                    app.set_persist_composer_context_strip(*enabled, cx);
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
                SettingsEvent::LinkedEnvironmentEnabled {
                    environment_id,
                    enabled,
                } => {
                    app.set_linked_environment_enabled(environment_id, *enabled, cx);
                }
                SettingsEvent::LinkInstance { server_id, linked } => {
                    app.set_linked_instance(server_id, *linked, cx);
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
        self.push_server_config(cx);
        self.sync_browser_visibility(cx);
        cx.notify();
    }

    /// A full-height seam with a `16px` (`w-4`) drag handle over it (Conn's `SidebarRail`):
    /// a `1px` stripe lights on hover, dragging resizes, and double-click resets the width.
    fn render_seam(
        &self,
        right_panel: bool,
        viewport_w: f32,
        cx: &mut Context<'_, Self>,
    ) -> impl IntoElement {
        use crate::panels::chrome::ConnTooltipExt as _;
        use gpui_kit::{CursorStyle, MouseButton, MouseDownEvent, TestSupportExt as _};
        let stripe = hsla(self.tokens.sidebar_border);
        // The panel as drawn, which may be narrower than the width kept for it: the drag starts
        // from what the user sees.
        let panel_width_now = self.right_panel_effective_width(viewport_w);
        let dragging = matches!(
            (self.seam_drag, right_panel),
            (Some(SeamDrag::RightPanel { .. }), true) | (Some(SeamDrag::Sidebar { .. }), false)
        );
        let handle = div()
            .id(if right_panel {
                "seam-right-panel"
            } else {
                "seam-sidebar"
            })
            .test_support()
            .a11y_button(
                if right_panel {
                    "shell.seam.right-panel"
                } else {
                    "shell.seam.sidebar"
                },
                if right_panel {
                    "Resize panel"
                } else {
                    "Resize sidebar"
                },
            )
            .absolute()
            .top_0()
            .bottom_0()
            .left(px(-8.0))
            .w(px(16.0))
            .flex()
            .justify_center()
            .group("seam-handle")
            .cursor(CursorStyle::ResizeLeftRight)
            .conn_tooltip(
                if right_panel {
                    "Drag to resize panel"
                } else {
                    "Drag to resize sidebar"
                },
                &self.tokens,
            )
            .child(
                div()
                    .h_full()
                    .w(px(1.0))
                    .when(dragging, move |s| s.bg(stripe))
                    .group_hover("seam-handle", move |s| s.bg(stripe)),
            )
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |app, event: &MouseDownEvent, _, cx| {
                    cx.stop_propagation();
                    let x = f32::from(event.position.x);
                    if event.click_count >= 2 {
                        // `resetSidebarWidth`: back to the default, which is then not kept.
                        let (kept_sidebar, kept_panel) = app.sidebar.saved_widths();
                        if right_panel {
                            app.layout
                                .set_right_panel_width(conn_state::RIGHT_PANEL_DEFAULT_WIDTH);
                            app.sidebar.remember_widths(kept_sidebar, None);
                        } else {
                            app.layout
                                .set_sidebar_width(conn_state::SIDEBAR_DEFAULT_WIDTH);
                            app.sidebar.remember_widths(None, kept_panel);
                        }
                        app.seam_drag = None;
                    } else if right_panel {
                        app.seam_drag = Some(SeamDrag::RightPanel {
                            from_x: x,
                            start: panel_width_now,
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
    /// The right panel is open and no GPUI overlay covers it.
    fn right_panel_surface_visible(&self) -> bool {
        self.layout.right_panel_open
            && !self.right_panel_tabs.tabs().is_empty()
            && self.command_palette.is_none()
            && self.settings_modal.is_none()
            && self.workspace_editor.is_none()
    }

    fn sync_browser_visibility(&self, cx: &mut Context<'_, Self>) {
        let visible = self.right_panel_surface_visible();
        self.right_panel
            .update(cx, |panel, cx| panel.set_surface_visible(visible, cx));
    }

    fn sync_files_subscription(&mut self) {
        let next = self
            .layout
            .selected_thread_id
            .as_ref()
            .filter(|_| self.draft.is_none())
            .and_then(|thread| {
                Some(FilesSubscription {
                    connection: self.connection_for_thread(thread)?,
                    thread: thread.clone(),
                })
            });
        if let (Some(old), Some(next)) = (&self.files_subscription, &next)
            && next.connection.same_connection(&old.connection)
            && next.thread == old.thread
        {
            return;
        }
        if let Some(old) = self.files_subscription.take()
            && !next
                .as_ref()
                .is_some_and(|new| new.connection.same_connection(&old.connection))
        {
            old.connection
                .subscribe_panel_requests(Some(self.device_name()));
        }
        if let Some(next) = &next {
            next.connection.subscribe_files_thread(
                Some(self.device_name()),
                Some(next.thread.clone()),
                false,
            );
        }
        self.files_subscription = next;
    }

    /// Pushes the selected thread's timeline (or active draft state) into the chat view and right panel.
    fn sync_chat(&mut self, cx: &mut Context<'_, Self>) {
        if self.sync_panel_owner() {
            self.save_thread_panels(cx);
        }
        self.refresh_selected_outline(cx);
        self.sync_chat_environment(cx);
        let child_approvals = self.sync_child_approvals();
        self.sync_files_subscription();
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
                    pinned: matches!(p.pinned_at, Some(Some(_))),
                    is_scratch: self.is_scratch_project(&p.id, Some(&p.workspace_root)),
                    shell: p.clone(),
                })
                .collect();
            crate::chat::DraftViewInfo {
                draft_id: draft.draft_id.clone(),
                project_id: draft.project_id.clone(),
                project_title: project
                    .map(|p| p.title.clone())
                    .unwrap_or_else(|| draft.project_id.clone()),
                projects,
                launching: draft.launching,
                is_scratch: self.is_scratch_project(
                    &draft.project_id,
                    project.map(|p| p.workspace_root.as_str()),
                ),
                scratch_available: self.scratch_root_for_project(&draft.project_id).is_some(),
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
        let thread_connected = selected.is_some_and(|id| self.thread_connected(id));
        let outline = selected.and_then(|id| self.cached_outline(id));
        let timeline = selected.and_then(|id| self.threads.get(id));
        let fallback = selected.map(conn_state::ThreadState::new);
        let thread = timeline.or(fallback.as_ref());
        let project_id = shell_thread
            .map(|t| t.project_id.clone())
            .or_else(|| self.draft.as_ref().map(|d| d.project_id.clone()));
        let thread_id = selected.map(str::to_owned);
        let surface = self.right_panel_surface();
        let surface_visible = self.right_panel_surface_visible();
        let panel_root = root.clone();
        let environment_id = self.environment_id();
        let panel_owner = self.thread_panels.owner().cloned();
        let linked_environment = self.context_environment();
        self.right_panel.update(cx, |panel, cx| {
            panel.set_environment(environment_id, cx);
            panel.set_owner(panel_owner, cx);
            panel.set_linked_environment(linked_environment, cx);
            panel.set_context(project_id.clone(), panel_root, thread_id, shell_thread, cx);
            panel.show_surface(&surface, surface_visible, cx);
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
                draft.branch.clone(),
                draft.use_worktree || draft.worktree_path.is_some(),
                draft.runtime_mode.clone(),
                draft.interaction_mode.clone(),
            )
        } else {
            let model =
                shell_thread.and_then(|t| t.model_selection.model.as_str().map(str::to_owned));
            let model_instance = shell_thread.map(|t| t.provider_instance_id.clone());
            let model_options = shell_thread
                .map(|t| conn_contract::to_json(&t.model_selection))
                // `options` is `[{ id, value }]` on the wire; reading it as an object found nothing
                // and the picker showed the catalog default effort (Nick, #333).
                .and_then(|v| {
                    v.get("options")
                        .and_then(conn_state::providers::model_options_from_json)
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
        let linked_pull_requests: Vec<crate::chat::LinkedPullRequest> = shell_thread
            .and_then(|t| t.pull_requests.as_deref())
            .map(|links| {
                crate::panels::linked_items::pr_link::visible_thread_pull_requests(links)
                    .iter()
                    .map(|link| {
                        crate::chat::LinkedPullRequest::new(
                            &link.host,
                            &link.repository,
                            link.number,
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        let branch_context = self.branch_context(shell_thread, &branch);
        let has_projects = self.shell.projects.iter().any(|p| p.archived_at.is_none());
        let connected = self.connection.is_some();
        let perf_open = if self.perf_open_pending_chat {
            self.perf_open_pending_chat = false;
            self.perf_open.clone()
        } else {
            None
        };
        let preferred_editor = self.thread_details.preferred_editor;
        self.chat.update(cx, |chat, cx| {
            if let Some((perf_thread, opened_at)) = perf_open {
                chat.set_perf_open(perf_thread, opened_at);
            }
            chat.set_shell_availability(has_projects, connected, cx);
            chat.set_draft(draft_view, cx);
            chat.set_project_id(project_id.clone(), cx);
            chat.set_workspace_root(root, cx);
            chat.set_thread(thread, title, cx);
            chat.set_linked_pull_requests(linked_pull_requests, cx);
            chat.set_preferred_editor(preferred_editor);
            chat.set_outline(outline, cx);
            if thread_connected {
                chat.clear_offline_prompt_notice(cx);
            }
            chat.set_child_approvals(child_approvals, cx);
            chat.set_branch_context(branch_context, cx);
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
                        let mut shell_changed = false;
                        for event in batch {
                            if matches!(
                                event,
                                ClientEvent::Status(_) | ClientEvent::BearerIssued(_)
                            ) {
                                status_changed = true;
                            }
                            shell_changed |= matches!(event, ClientEvent::Shell(_));
                            app.apply_event(event, orbit_server_id.as_deref(), cx);
                        }
                        if shell_changed {
                            app.expire_offline(cx);
                            app.reconcile_offline(cx);
                        }
                        app.schedule_offline_save(cx);
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
                } else {
                    // A reconnect may reach another server: its next snapshot confirms who.
                    self.primary_confirmed = false;
                }
                if !matches!(status, ConnectionStatus::Connected)
                    && let Some(env) = self.server_url.as_deref()
                {
                    self.offline.disconnected(env);
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
                self.remerge_linked_shells();
                self.offline.shell_changed();
                if self.shell.synchronized
                    && self
                        .layout
                        .selected_thread_id
                        .as_deref()
                        .is_some_and(|id| self.shell.find_thread(id).is_none())
                {
                    self.unsubscribe_open_thread();
                    self.layout.selected_thread_id = None;
                }
                self.release_settled_drop();
                if change.snapshot_required || !change.threads_changed.is_empty() {
                    self.drive_older_pages(cx);
                }
                if !change.threads_changed.is_empty() {
                    self.resubscribe_ended_threads();
                }
                if change.snapshot_required
                    && let Some(connection) = &self.connection
                {
                    connection.subscribe_shell_with_idle_subagents();
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
                        .or_else(|| self.shell.threads.iter().find(|t| self.shell.is_listed(t)))
                        .map(|first| (first.project_id.clone(), first.id.clone()));
                    if let Some((project_id, thread_id)) = initial {
                        self.layout.selected_project_id = Some(project_id);
                        self.open_thread(thread_id);
                    }
                }
            }
            ClientEvent::Thread { thread_id, item } => {
                let perf_kind = self
                    .perf_open
                    .as_ref()
                    .filter(|(id, _)| *id == thread_id)
                    .map(|(_, opened_at)| (thread_stream_item_kind(&item), *opened_at));
                let apply_start = std::time::Instant::now();
                if let Some(env) = self.server_url.clone() {
                    self.apply_cache_stream(&env, &thread_id, item);
                } else {
                    self.threads
                        .entry(thread_id.clone())
                        .or_insert_with(|| ThreadState::new(&thread_id))
                        .apply(item);
                }
                if let Some((kind, opened_at)) = perf_kind
                    && kind != "event"
                {
                    conn_client::perf_log!(
                        "app.applied thread={thread_id} kind={kind} entries={} apply_ms={:.1} +{:.1}ms",
                        self.threads.get(&thread_id).map_or(0, |t| t.entries.len()),
                        conn_client::perf::ms_since(apply_start),
                        conn_client::perf::ms_since(opened_at),
                    );
                }
            }
            ClientEvent::ServerConfig(event) => self.apply_server_config_event(*event, cx),
            ClientEvent::PanelRequest(request) => {
                if let Some(connection) = self.connection.clone() {
                    self.dispatch_agent_panel_request(
                        request,
                        PanelOrigin::Primary,
                        PanelReply::Server(connection),
                        cx,
                    );
                }
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
                if tag == "subscribeServerConfig" {
                    // A stream that ends cleanly is asked for again. One that fails stays down:
                    // a server without the method would fail again at once.
                    match (&error, &self.connection) {
                        (None, Some(connection)) => connection.subscribe_server_config(),
                        (Some(error), _) => eprintln!("server config stream ended: {error}"),
                        (None, None) => {}
                    }
                }
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

    /// Applies one `subscribeServerConfig` event and hands the new catalog to every reader.
    fn apply_server_config_event(
        &mut self,
        event: conn_contract::ServerConfigStreamEvent,
        cx: &mut Context<'_, Self>,
    ) {
        self.record_primary_machine(&event);
        if let conn_contract::ServerConfigStreamEvent::Snapshot(snapshot) = &event {
            self.learn_primary_environment(snapshot.config.environment.environment_id.clone(), cx);
        }
        let change = std::sync::Arc::make_mut(&mut self.server_config).apply(event);
        if change.config_changed {
            let root = self
                .server_config
                .scratch_workspace_root()
                .map(str::to_owned);
            if self.scratch_workspace_root != root {
                self.scratch_workspace_root = root;
                self.sync_chat(cx);
            }
        }
        if change.any() {
            self.push_server_config(cx);
        }
    }

    /// Gives the chat and an open Settings window the current server config.
    fn push_server_config(&mut self, cx: &mut Context<'_, Self>) {
        // The composer and the right panel offer the catalog of the open thread's environment;
        // Settings stays on the connected one.
        let config = self.active_server_config();
        self.chat.update(cx, |chat, cx| {
            chat.set_server_config(std::sync::Arc::clone(&config), cx)
        });
        self.right_panel.update(cx, |panel, cx| {
            panel.set_server_config(std::sync::Arc::clone(&config), cx)
        });
        let primary_config = std::sync::Arc::clone(&self.server_config);
        if let Some(modal) = &self.settings_modal {
            let shells = self
                .shell
                .projects
                .iter()
                .filter(|p| p.archived_at.is_none())
                .cloned()
                .collect();
            modal.update(cx, |modal, cx| {
                modal.set_project_shells(shells, cx);
                modal.set_server_config(primary_config, cx);
            });
        }
        cx.notify();
    }

    /// `Open provider setup`: Settings on the Providers page, on `instance_id`.
    pub(crate) fn open_provider_setup(
        &mut self,
        instance_id: &str,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.open_settings_page(Some(crate::settings::SettingsPage::Providers), window, cx);
        if let Some(modal) = &self.settings_modal {
            let instance_id = instance_id.to_owned();
            modal.update(cx, |modal, cx| modal.focus_provider(instance_id, cx));
        }
    }

    /// Resubscribes ended thread streams whose thread the shell now lists.
    fn resubscribe_ended_threads(&mut self) {
        let ready: Vec<String> = self
            .ended_threads
            .iter()
            .filter(|id| self.shell.find_thread(id).is_some())
            .cloned()
            .collect();
        for id in ready {
            let Some(connection) = self.connection_for_thread(&id) else {
                continue;
            };
            self.ended_threads.remove(&id);
            connection.subscribe_thread(&id);
        }
    }

    /// Selects `thread_id` and subscribes to its timeline once.
    fn open_thread(&mut self, thread_id: String) {
        self.restore_offline_chat(&thread_id);
        self.park_active_draft();
        if conn_client::perf::enabled()
            && self.layout.selected_thread_id.as_deref() != Some(thread_id.as_str())
        {
            let cached = self.threads.get(&thread_id).map(|t| t.entries.len());
            conn_client::perf_log!("app.open_thread thread={thread_id} cached_entries={cached:?}");
            self.perf_open = Some((thread_id.clone(), std::time::Instant::now()));
            self.perf_open_pending_chat = true;
        }
        if self.connection.is_some()
            && self.subscribed_thread_id.as_deref() != Some(thread_id.as_str())
        {
            self.subscribe_open_thread(&thread_id);
        }
        self.layout.selected_thread_id = Some(thread_id);
    }

    /// Fetches the next older history page for the currently selected bounded thread and prepends
    /// its entries into [`ThreadState`] without losing the user's scroll position.
    fn load_earlier_history(&mut self, cx: &mut Context<'_, Self>) {
        let Some(thread_id) = self.layout.selected_thread_id.clone() else {
            return;
        };
        if self.load_cached_page(&thread_id) {
            self.sync_chat(cx);
            return;
        }
        let Some(connection) = self
            .connection_for_thread(&thread_id)
            .filter(|_| self.thread_connected(&thread_id))
        else {
            if let Some(thread) = self.threads.get_mut(&thread_id) {
                thread.has_more_history = false;
            }
            self.sync_chat(cx);
            return;
        };
        let env = self.cache_env(&thread_id).map(str::to_owned);
        let snapshot_cursor = self.offline.snapshot_cursor(env.as_deref(), &thread_id);
        let (cursor, anchor) = {
            let Some(thread) = self.threads.get_mut(&thread_id) else {
                return;
            };
            if !thread.has_more_history || thread.loading_earlier {
                return;
            }
            let Some(first) = thread.entries.first() else {
                return;
            };
            thread.loading_earlier = true;
            (thread.history_cursor.clone(), first.id().to_owned())
        };
        self.sync_chat(cx);

        let generation = self.connection_gen;
        let serial = self.offline.snapshot_serial(env.as_deref(), &thread_id);
        let expected_anchor = anchor.clone();
        let expected_cursor = cursor.clone();
        let req_thread_id = thread_id.clone();

        cx.spawn(async move |this, cx| {
            let task = crate::live::RT.spawn(async move {
                if let Some(cursor) = cursor {
                    connection
                        .fetch_thread_history_page(&req_thread_id, &cursor)
                        .await
                } else {
                    let cursor = snapshot_cursor.ok_or_else(|| {
                        conn_client::ClientError::Connection(
                            "waiting for the bounded thread snapshot".to_owned(),
                        )
                    })?;
                    connection
                        .fetch_history_before_message(&req_thread_id, &cursor, &anchor)
                        .await
                }
            });
            let result = match task.await {
                Ok(res) => res,
                Err(join_err) => Err(conn_client::ClientError::Connection(format!(
                    "thread history task failed: {join_err}"
                ))),
            };
            let _ = this.update(cx, |app, cx| {
                if app.connection_gen != generation
                    || app.cache_env(&thread_id) != env.as_deref()
                    || app.offline.snapshot_serial(env.as_deref(), &thread_id) != serial
                {
                    return;
                }
                if let Some(thread) = app.threads.get_mut(&thread_id) {
                    if thread.history_cursor == expected_cursor
                        && thread
                            .entries
                            .first()
                            .is_some_and(|entry| entry.id() == expected_anchor)
                    {
                        match result {
                            Ok(page) => {
                                thread.prepend_history_page(page);
                            }
                            Err(err) => {
                                eprintln!(
                                    "conn-app: failed to load earlier history ({thread_id}): {err}"
                                );
                                thread.loading_earlier = false;
                            }
                        }
                    } else {
                        thread.loading_earlier = false;
                    }
                }
                if app.layout.selected_thread_id.as_deref() == Some(thread_id.as_str()) {
                    app.sync_chat(cx);
                }
            });
        })
        .detach();
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
                .and_then(conn_state::providers::model_options_from_json);
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

        // Each project opens its own draft: coming back restores its model, modes and workspace
        // choice (the composer's draft store restores the text).
        let project_key = self.project_draft_key(&project_id);
        self.park_active_draft();
        let session = self
            .drafts
            .take_for_project(&project_key)
            .unwrap_or_else(|| {
                let session = DraftThreadState {
                    draft_id: new_draft_id(),
                    environment_id: self.environment_id(),
                    project_id,
                    created_at_ms: now_ms(),
                    model_instance_id,
                    model_slug,
                    model_options,
                    runtime_mode,
                    interaction_mode,
                    use_worktree: false,
                    branch: None,
                    worktree_path: None,
                    start_from_origin: false,
                    launching: false,
                };
                self.drafts.map(&project_key, &session.draft_id);
                session
            });
        self.activate_draft(session, window, cx);
    }

    /// Shows `session` as the open draft: the chat card switches to it and the sidebar row of
    /// the draft it replaced comes back from the parked set.
    fn activate_draft(
        &mut self,
        session: DraftThreadState,
        window: Option<&mut Window>,
        cx: &mut Context<'_, Self>,
    ) {
        self.unsubscribe_open_thread();
        self.layout.selected_project_id = Some(session.project_id.clone());
        self.layout.selected_thread_id = None;
        let frozen = self.sidebar_row_of_opening_draft(&session, cx);
        self.drafts.set_frozen_active(frozen);
        self.draft = Some(session);
        self.chat.update(cx, |chat, cx| chat.set_error(None, cx));
        self.sync_chat(cx);
        if let Some(window) = window {
            self.chat
                .update(cx, |chat, cx| chat.focus_composer(window, cx));
        }
        self.settle_drafts(cx);
        cx.notify();
    }

    /// Opens a draft from its sidebar row, after parking the open one. Opening an unmapped draft
    /// does not remap its project: `New thread` there still opens the project's own draft.
    pub(crate) fn open_draft(
        &mut self,
        draft_id: &str,
        window: Option<&mut Window>,
        cx: &mut Context<'_, Self>,
    ) {
        if self.draft.as_ref().is_some_and(|d| d.draft_id == draft_id) {
            if let Some(window) = window {
                self.chat
                    .update(cx, |chat, cx| chat.focus_composer(window, cx));
            }
            return;
        }
        if !self.drafts.get(draft_id).is_some_and(|d| !d.launching) {
            return;
        }
        self.park_active_draft();
        if let Some(session) = self.drafts.take(draft_id) {
            self.activate_draft(session, window, cx);
        }
    }

    /// Discards a draft (`discardComposerDraft`): its text, attachments and project slot go, and
    /// `Undo` brings them back for a while. Discarding the open draft falls back to the most
    /// recent active thread.
    pub(crate) fn discard_draft_row(
        &mut self,
        draft_id: &str,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        // The keyboard may be on the row or its `x`, both about to go; the sidebar hands it to
        // the row that takes the place.
        self.sidebar_tree
            .take_focus(&conn_state::draft_tree_key(draft_id), window, cx);
        let was_open = self.draft.as_ref().is_some_and(|d| d.draft_id == draft_id);
        let session = if was_open {
            self.draft.take()
        } else {
            self.drafts.take(draft_id)
        };
        let Some(session) = session else {
            return;
        };
        if session.launching {
            // The thread is being created from it; discarding now would strand the send.
            if was_open {
                self.draft = Some(session);
            } else {
                self.drafts.park(session);
            }
            return;
        }
        let project_key = self.drafts.project_key_of(draft_id);
        self.drafts.forget(draft_id);
        self.drafts.set_frozen_active(None);
        let content = self
            .chat
            .update(cx, |chat, cx| chat.discard_draft(draft_id, cx));
        self.offer_draft_undo(
            DiscardedDraft::New {
                session,
                content,
                project_key,
            },
            cx,
        );
        if was_open {
            self.chat.update(cx, |chat, cx| chat.set_error(None, cx));
            let initial = self
                .shell
                .top_level_active_threads()
                .next()
                .or_else(|| self.shell.threads.iter().find(|t| self.shell.is_listed(t)))
                .map(|first| (first.project_id.clone(), first.id.clone()));
            if let Some((project_id, thread_id)) = initial {
                self.layout.selected_project_id = Some(project_id);
                self.open_thread(thread_id);
            }
        }
        self.sync_chat(cx);
        self.settle_drafts(cx);
        cx.notify();
    }

    /// The `X` on a started thread's row: clears the unsent input in its composer and offers
    /// `Undo` (`discardComposerDraft` on a thread target).
    pub(crate) fn discard_thread_draft_row(
        &mut self,
        thread_id: &str,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if self.layout.selected_thread_id.as_deref() == Some(thread_id) && self.draft.is_none() {
            return;
        }
        // The `x` leaves with the pen mark; the keyboard goes to the row.
        self.sidebar_tree.take_focus(thread_id, window, cx);
        let content = self
            .chat
            .update(cx, |chat, cx| chat.discard_thread_draft(thread_id, cx));
        if let Some(content) = content {
            self.offer_draft_undo(
                DiscardedDraft::Thread {
                    thread_id: thread_id.to_owned(),
                    content,
                },
                cx,
            );
        }
        self.settle_drafts(cx);
        cx.notify();
    }

    /// The draft `draft_id` names: the open one, or a parked one.
    fn draft_session(&self, draft_id: &str) -> Option<&DraftThreadState> {
        self.draft
            .as_ref()
            .filter(|d| d.draft_id == draft_id)
            .or_else(|| self.drafts.get(draft_id))
    }

    /// Items of the open sidebar menu: a draft row's, or a thread's.
    fn thread_menu_items(
        &self,
        anchor: &ThreadMenuAnchor,
    ) -> Option<Vec<crate::sidebar::thread_menu::ThreadMenuItem>> {
        if anchor.draft {
            let draft = self.draft_session(&anchor.thread_id)?;
            return Some(build_draft_action_menu_items(DraftMenuState {
                has_path: self.draft_workspace_path(draft).is_some(),
                has_branch: draft.branch.as_deref().is_some_and(|b| !b.is_empty()),
                has_project: self.shell.project(&draft.project_id).is_some(),
            }));
        }
        if anchor.bulk {
            let ids = self.bulk_targets();
            return (!ids.is_empty()).then(|| build_bulk_menu_items(self.bulk_facts(&ids)));
        }
        let thread = self.shell.find_thread(&anchor.thread_id)?;
        let state =
            ThreadMenuState::for_thread(&self.shell, thread, self.active_workspace.as_deref());
        Some(build_thread_action_menu_items(&state))
    }

    /// Opens the menu of a draft row at `position` (window coordinates).
    pub(crate) fn open_draft_menu(
        &mut self,
        draft_id: String,
        position: gpui_kit::Point<gpui_kit::Pixels>,
        cx: &mut Context<'_, Self>,
    ) {
        if self.draft_session(&draft_id).is_none_or(|d| d.launching) {
            return;
        }
        self.thread_details.copy_menu = None;
        self.thread_hover.dismiss();
        self.thread_menu_copy_close_gen = self.thread_menu_copy_close_gen.wrapping_add(1);
        self.thread_menu_focus_pending = true;
        self.thread_menu = Some(ThreadMenuAnchor {
            thread_id: draft_id,
            draft: true,
            bulk: false,
            position,
            copy_open: false,
            cursor: MenuCursor::default(),
        });
        cx.notify();
    }

    /// The path `Copy > Path` gives for a draft: its worktree, else its project's folder.
    fn draft_workspace_path(&self, draft: &DraftThreadState) -> Option<String> {
        draft.worktree_path.clone().or_else(|| {
            self.shell
                .project(&draft.project_id)
                .map(|p| p.workspace_root.clone())
        })
    }

    /// Runs one item of a draft row's menu (`handleDraftContextMenu`).
    pub(crate) fn run_draft_menu_action(
        &mut self,
        draft_id: String,
        action: ThreadMenuAction,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.thread_menu = None;
        cx.notify();
        let Some(draft) = self.draft_session(&draft_id).cloned() else {
            return;
        };
        match action {
            ThreadMenuAction::CopyPath => {
                if let Some(path) = self.draft_workspace_path(&draft) {
                    self.copy_to_clipboard(path, cx);
                }
            }
            ThreadMenuAction::CopyBranch => {
                if let Some(branch) = draft.branch.filter(|b| !b.is_empty()) {
                    self.copy_to_clipboard(branch, cx);
                }
            }
            ThreadMenuAction::ProjectSettings => {
                if self.settings_modal.is_none() {
                    self.open_settings(window, cx);
                }
            }
            // The menu may outlive the send: a launching draft is not discarded.
            ThreadMenuAction::DiscardDraft if !draft.launching => {
                self.discard_draft_row(&draft_id, window, cx);
            }
            _ => {}
        }
    }

    /// Changes the target project of the open draft, as Conn's picker does
    /// (`DraftHeroHeadline` `selectProject`). A draft with text or attachments moves to the
    /// project, and the project's own draft becomes an unmapped draft in the sidebar. An empty
    /// draft stays behind its own project, and the project's own draft opens.
    pub(crate) fn set_draft_project(&mut self, project_id: String, cx: &mut Context<'_, Self>) {
        let Some(draft) = &self.draft else {
            return;
        };
        if draft.launching || draft.project_id == project_id {
            return;
        }
        let has_content = self.chat.read(cx).draft_has_content(cx);
        let target_key = self.project_draft_key(&project_id);
        let draft_id = draft.draft_id.clone();
        match self.drafts.retarget(&draft_id, &target_key, has_content) {
            conn_state::Retarget::OpenProjectDraft => {
                self.start_new_thread(Some(project_id), None, cx);
            }
            conn_state::Retarget::Move { .. } => {
                if let Some(draft) = &mut self.draft {
                    draft.project_id.clone_from(&project_id);
                    draft.branch = None;
                    draft.worktree_path = None;
                }
                self.drafts.set_frozen_project(&project_id);
                self.layout.selected_project_id = Some(project_id);
                self.sync_chat(cx);
                self.settle_drafts(cx);
                cx.notify();
            }
        }
    }

    /// Parks the open draft, a launching one included so its launch can finish.
    fn park_active_draft(&mut self) {
        if let Some(draft) = self.draft.take() {
            self.drafts.park(draft);
        }
        self.drafts.set_frozen_active(None);
    }

    /// The connected environment drafts belong to.
    fn environment_id(&self) -> String {
        self.orbit
            .active_server_id
            .clone()
            .or_else(|| self.server_url.clone())
            .unwrap_or_default()
    }

    fn project_draft_key(&self, project_id: &str) -> String {
        conn_state::project_draft_key(&self.environment_id(), project_id)
    }

    /// The sidebar row `session` gets while it is open: fixed when it opens, so the list does not
    /// move while the user types, and none when the draft was empty.
    fn sidebar_row_of_opening_draft(
        &self,
        session: &DraftThreadState,
        cx: &App,
    ) -> Option<conn_state::SidebarDraftRow> {
        let mut row = None;
        self.chat.read(cx).visit_drafts(cx, |id, text, count| {
            if id == session.draft_id {
                row = conn_state::freeze_active_draft_row(&conn_state::SidebarDraft {
                    draft_id: id,
                    project_id: &session.project_id,
                    created_at_ms: session.created_at_ms,
                    launching: session.launching,
                    prompt: text,
                    attachment_count: count,
                });
            }
        });
        row
    }

    /// The draft rows of the thread sidebar: the parked drafts that hold content, and the open
    /// draft's frozen row, newest first, limited to the sidebar's project scope.
    fn sidebar_draft_rows(&self, cx: &App) -> Vec<conn_state::SidebarDraftRow> {
        let environment = self.environment_id();
        let open_id = self.draft.as_ref().map(|d| d.draft_id.as_str());
        let mut rows: Vec<conn_state::SidebarDraftRow> =
            self.drafts.frozen_active().cloned().into_iter().collect();
        self.chat.read(cx).visit_drafts(cx, |id, text, count| {
            if Some(id) == open_id {
                return;
            }
            let Some(session) = self
                .drafts
                .get(id)
                .filter(|session| session.environment_id == environment)
            else {
                return;
            };
            rows.extend(conn_state::sidebar_draft_row(&conn_state::SidebarDraft {
                draft_id: id,
                project_id: &session.project_id,
                created_at_ms: session.created_at_ms,
                launching: session.launching,
                prompt: text,
                attachment_count: count,
            }));
        });
        conn_state::sidebar_draft_rows(rows, |project_id| {
            self.shell.project(project_id).is_some()
                && crate::sidebar::thread_list::project_in_scope(
                    &self.shell,
                    &self.orbit.workspaces,
                    self.active_workspace.as_deref(),
                    project_id,
                )
        })
    }

    /// Started threads whose composer holds unsent input: their rows carry the pen mark. The
    /// open thread is left out, its composer is on screen.
    fn sidebar_unsent_threads(&self, cx: &App) -> HashSet<String> {
        let open_thread = self
            .layout
            .selected_thread_id
            .as_deref()
            .filter(|_| self.draft.is_none());
        let mut unsent = HashSet::new();
        self.chat
            .read(cx)
            .visit_thread_drafts(cx, |thread_id, text, count| {
                unsent.extend(conn_state::threads_with_unsent_input(
                    [(thread_id, text, count)],
                    open_thread,
                ));
            });
        unsent
    }

    /// Parks the drafts saved by the last run, with their text and attachments.
    fn restore_saved_drafts(&mut self, cx: &mut Context<'_, Self>) {
        let Some(mut saved) = self
            .drafts_path
            .as_deref()
            .and_then(crate::drafts::load_saved_drafts)
        else {
            return;
        };
        for (thread_id, content) in saved.take_threads() {
            self.chat.update(cx, |chat, cx| {
                chat.restore_thread_draft(&thread_id, content, cx)
            });
        }
        for (draft_id, content) in self.drafts.restore(saved) {
            self.chat
                .update(cx, |chat, cx| chat.restore_draft(&draft_id, content, cx));
        }
    }

    /// Drops parked drafts nothing opens and that hold nothing, then saves the drafts file when
    /// it changed. Runs after every change to the drafts and once a second.
    fn settle_drafts(&mut self, cx: &mut Context<'_, Self>) {
        let contents: HashMap<String, DraftContent> =
            self.chat.read(cx).saved_drafts(cx).into_iter().collect();
        let mut with_content = HashSet::new();
        self.chat.read(cx).visit_drafts(cx, |id, text, count| {
            if conn_state::draft_has_content(text, count) {
                with_content.insert(id.to_owned());
            }
        });
        self.drafts.drop_unreachable(|id| with_content.contains(id));
        let Some(path) = &self.drafts_path else {
            return;
        };
        let Some(json) = self
            .drafts
            .capture(
                self.draft.as_ref(),
                &contents,
                self.chat.read(cx).saved_thread_drafts(cx),
            )
            .to_json()
        else {
            return;
        };
        if self.saved_drafts_json.as_deref() == Some(json.as_str()) {
            return;
        }
        match crate::drafts::write_drafts_file(path, &json) {
            Ok(()) => self.saved_drafts_json = Some(json),
            Err(err) => eprintln!("drafts: could not save {}: {err}", path.display()),
        }
    }

    /// Workspace facts for the composer's context strip.
    fn branch_context(
        &self,
        shell_thread: Option<&conn_state::ThreadShell>,
        branch: &Option<String>,
    ) -> crate::chat::BranchContext {
        let project_id = shell_thread
            .map(|t| t.project_id.as_str())
            .or_else(|| self.draft.as_ref().map(|d| d.project_id.as_str()));
        let project_cwd = project_id
            .and_then(|id| self.shell.project(id))
            .map(|p| p.workspace_root.clone());
        let worktree_path = match (shell_thread, &self.draft) {
            (Some(t), _) => t.worktree_path.clone(),
            (None, Some(d)) => d.worktree_path.clone(),
            (None, None) => None,
        };
        let previous_worktree = self.draft.as_ref().and_then(|d| {
            crate::chat::previous_worktree(
                self.shell.threads_for_project(&d.project_id).map(|t| {
                    crate::chat::ThreadWorkspace {
                        branch: t.branch.as_deref(),
                        worktree_path: t.worktree_path.as_deref(),
                        updated_at: &t.updated_at,
                        archived: t.archived_at.is_some(),
                    }
                }),
                d.worktree_path.as_deref(),
            )
        });
        crate::chat::BranchContext {
            project_cwd,
            worktree_path,
            branch: branch.clone(),
            start_from_origin: self.draft.as_ref().is_some_and(|d| d.start_from_origin),
            previous_worktree,
            worktree_change_blocked: shell_thread.is_some()
                && self
                    .layout
                    .selected_thread_id
                    .as_deref()
                    .and_then(|id| self.threads.get(id))
                    .is_some_and(|t| t.working),
        }
    }

    /// Carries out a branch or workspace change from the composer context strip.
    fn handle_branch_action(
        &mut self,
        action: crate::chat::BranchAction,
        cx: &mut Context<'_, Self>,
    ) {
        use crate::chat::BranchAction;
        match action {
            BranchAction::WorkspaceMode(use_worktree) => {
                if let Some(draft) = &mut self.draft {
                    draft.worktree_path = None;
                }
                self.set_draft_workspace_strategy(use_worktree, cx);
            }
            BranchAction::StartFromOrigin(on) => {
                if let Some(draft) = &mut self.draft {
                    draft.start_from_origin = on;
                    self.sync_chat(cx);
                }
            }
            BranchAction::UsePreviousWorktree(seed) => {
                if let Some(draft) = &mut self.draft
                    && !draft.launching
                {
                    draft.use_worktree = false;
                    draft.worktree_path = Some(seed.worktree_path);
                    draft.branch = seed.branch;
                    self.sync_chat(cx);
                }
            }
            BranchAction::SelectRef(entry) => self.select_branch_ref(entry, cx),
            BranchAction::CreateRef(name) => self.create_branch_ref(name, cx),
        }
    }

    /// The thread's branch cwd and project root (`branchCwd`, `activeProjectCwd`).
    fn branch_cwds(&self) -> Option<(String, Option<String>, bool)> {
        let selected = self.layout.selected_thread_id.as_deref();
        if let Some(draft) = &self.draft {
            let root = self
                .shell
                .project(&draft.project_id)?
                .workspace_root
                .clone();
            return Some((root, draft.worktree_path.clone(), false));
        }
        let thread = selected.and_then(|id| self.shell.find_thread(id))?;
        let root = self
            .shell
            .project(&thread.project_id)?
            .workspace_root
            .clone();
        let working = self.threads.get(&thread.id).is_some_and(|t| t.working);
        Some((root, thread.worktree_path.clone(), working))
    }

    fn select_branch_ref(&mut self, entry: crate::chat::RefEntry, cx: &mut Context<'_, Self>) {
        let Some((project_cwd, worktree_path, working)) = self.branch_cwds() else {
            return;
        };
        if let Some(draft) = &mut self.draft
            && draft.use_worktree
            && draft.worktree_path.is_none()
        {
            draft.branch = Some(entry.name);
            self.sync_chat(cx);
            return;
        }
        let target =
            crate::chat::branch_selection_target(&project_cwd, worktree_path.as_deref(), &entry);
        if working && target.next_worktree_path != worktree_path {
            self.chat.update(cx, |chat, cx| {
                chat.set_error(
                    Some("Stop the current turn to switch worktrees.".to_owned()),
                    cx,
                );
            });
            return;
        }
        if target.reuse_existing_worktree && !target.stays_in_active_checkout {
            self.apply_thread_branch(Some(entry.name), target.next_worktree_path, cx);
            return;
        }
        let Some(connection) = self.context_connection() else {
            return;
        };
        let fallback = if entry.is_remote {
            crate::chat::local_branch_name_from_remote_ref(&entry.name).to_owned()
        } else {
            entry.name.clone()
        };
        let payload = conn_contract::VcsSwitchRefInput {
            cwd: target.checkout_cwd,
            ref_name: entry.name,
        };
        let next_worktree = target.next_worktree_path;
        cx.spawn(async move |this, cx| {
            let res = connection
                .call::<conn_contract::rpc::vcs::switch_ref::Payload, conn_contract::rpc::vcs::switch_ref::Success>(
                    "vcs.switchRef",
                    &payload,
                )
                .await;
            let _ = this.update(cx, |app, cx| match res {
                Ok(result) => {
                    let branch = result.ref_name.unwrap_or(fallback);
                    app.apply_thread_branch(Some(branch), next_worktree, cx);
                }
                Err(err) => app.chat.update(cx, |chat, cx| {
                    chat.set_error(Some(format!("Failed to switch ref. {err}")), cx);
                }),
            });
        })
        .detach();
    }

    fn create_branch_ref(&mut self, name: String, cx: &mut Context<'_, Self>) {
        let (Some(connection), Some((project_cwd, worktree_path, _))) =
            (self.context_connection(), self.branch_cwds())
        else {
            return;
        };
        let payload = conn_contract::VcsCreateRefInput {
            cwd: worktree_path.clone().unwrap_or(project_cwd),
            ref_name: name,
            switch_ref: Some(true),
        };
        cx.spawn(async move |this, cx| {
            let res = connection
                .call::<conn_contract::rpc::vcs::create_ref::Payload, conn_contract::rpc::vcs::create_ref::Success>(
                    "vcs.createRef",
                    &payload,
                )
                .await;
            let _ = this.update(cx, |app, cx| match res {
                Ok(result) => app.apply_thread_branch(Some(result.ref_name), worktree_path, cx),
                Err(err) => app.chat.update(cx, |chat, cx| {
                    chat.set_error(Some(format!("Failed to create and switch ref. {err}")), cx);
                }),
            });
        })
        .detach();
    }

    /// Records the branch and worktree on the draft, or on the thread (`thread.metadata.update`).
    fn apply_thread_branch(
        &mut self,
        branch: Option<String>,
        worktree_path: Option<String>,
        cx: &mut Context<'_, Self>,
    ) {
        if let Some(draft) = &mut self.draft {
            if worktree_path.is_some() {
                draft.use_worktree = false;
            }
            draft.branch = branch;
            draft.worktree_path = worktree_path;
            self.sync_chat(cx);
            return;
        }
        let (Some(connection), Some(thread_id)) = (
            self.context_connection(),
            self.layout.selected_thread_id.clone(),
        ) else {
            return;
        };
        let command =
            conn_contract::from_json::<conn_contract::OrchestrationV2Command>(serde_json::json!({
                "type": "thread.metadata.update",
                "commandId": format!("cmd-{}", crate::commands::new_thread_id()),
                "threadId": thread_id,
                "branch": branch,
                "worktreePath": worktree_path,
            }));
        let Ok(command) = command else {
            return;
        };
        cx.spawn(async move |_, _| {
            if let Err(e) = connection.dispatch_command(command).await {
                eprintln!("branch: thread.metadata.update failed: {e}");
            }
        })
        .detach();
    }

    /// Whether `project_id` is the server's scratch project (`isScratchProject`).
    fn is_scratch_project(&self, project_id: &str, workspace_root: Option<&str>) -> bool {
        if self.scratch_project_id.as_deref() == Some(project_id) {
            return true;
        }
        let trim = |path: &str| path.trim_end_matches('/').to_owned();
        match (self.scratch_root_for_project(project_id), workspace_root) {
            (Some(scratch), Some(root)) => trim(&scratch) == trim(root),
            _ => false,
        }
    }

    /// `or start without a project`: retargets the draft at `projects.ensureScratch`.
    fn start_draft_scratch(&mut self, cx: &mut Context<'_, Self>) {
        let Some(connection) = self.connection.clone() else {
            return;
        };
        if self.draft.as_ref().is_none_or(|d| d.launching) {
            return;
        }
        cx.spawn(async move |this, cx| {
            let result = connection
                .call::<conn_contract::rpc::projects::ensure_scratch::Payload, conn_contract::rpc::projects::ensure_scratch::Success>(
                    "projects.ensureScratch",
                    &conn_contract::ServerProbePayload {},
                )
                .await;
            let _ = this.update(cx, |app, cx| match result {
                Ok(project) => {
                    app.scratch_project_id = Some(project.project_id.clone());
                    app.set_draft_project(project.project_id, cx);
                }
                Err(err) => {
                    let message = format!("Could not start without a project. {err}");
                    app.chat
                        .update(cx, |chat, cx| chat.set_error(Some(message), cx));
                }
            });
        })
        .detach();
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
        let Some(connection) = self.context_connection() else {
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
        let draft_id = draft.draft_id.clone();

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
                    conn_state::providers::model_options_to_json(opts),
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
                obj.insert(
                    "options".to_owned(),
                    conn_state::providers::model_options_to_json(&opts),
                );
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
        let mut payload = crate::commands::launch_thread_payload(
            &thread_id,
            &project_id,
            &text,
            &attachments,
            model_json,
            &draft.runtime_mode,
            &draft.interaction_mode,
            strategy,
        );
        payload["workspaceStrategy"] = draft_workspace_strategy(&draft);

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
                        // The thread replaces the draft (`finalizePromotedDraftThread`). Someone who
                        // moved on to another thread meanwhile stays there.
                        let was_open = app.draft.as_ref().is_some_and(|d| d.draft_id == draft_id);
                        app.chat.update(cx, |chat, cx| {
                            chat.discard_draft(&draft_id, cx);
                        });
                        if was_open {
                            app.draft = None;
                            app.drafts.set_frozen_active(None);
                        }
                        app.drafts.forget(&draft_id);
                        let draft_owner = app.panel_owner_of_draft(&draft_id, &project_id);
                        app.thread_panels
                            .rename(&draft_owner, final_thread_id.clone());
                        app.save_thread_panels(cx);
                        if was_open {
                            app.layout.selected_project_id = Some(project_id.clone());
                            app.layout.selected_thread_id = Some(final_thread_id.clone());
                        }
                        app.ended_threads.remove(&final_thread_id);
                        connection.subscribe_thread(&final_thread_id);
                        app.chat.update(cx, |chat, cx| chat.set_error(None, cx));
                        app.sync_chat(cx);
                        app.settle_drafts(cx);
                        cx.notify();
                    }
                    Err(err) => {
                        let msg = crate::commands::format_client_error(&err);
                        eprintln!("new thread: launchThread failed: {msg}");
                        let was_open = app.draft.as_ref().is_some_and(|d| d.draft_id == draft_id);
                        if let Some(active_draft) = app.draft.as_mut().filter(|_| was_open) {
                            active_draft.launching = false;
                        } else if let Some(parked) = app.drafts.get_mut(&draft_id) {
                            parked.launching = false;
                        }
                        app.chat.update(cx, |chat, cx| {
                            chat.set_error(Some(format!("Could not create thread: {msg}")), cx);
                        });
                        if was_open && let Some(win) = launch_window {
                            let chat = app.chat.clone();
                            let restore = fallback_text.clone();
                            let _ = win.update(cx, |_, window, cx| {
                                chat.update(cx, |c, cx| c.set_draft_text(restore, window, cx));
                            });
                        } else if !was_open {
                            // The user moved on; the text goes back to the draft they left.
                            app.chat.update(cx, |chat, cx| {
                                chat.restore_draft(
                                    &draft_id,
                                    DraftContent {
                                        text: fallback_text.clone(),
                                        attachments: Vec::new(),
                                    },
                                    cx,
                                );
                            });
                        }
                        app.sync_chat(cx);
                        app.settle_drafts(cx);
                        cx.notify();
                    }
                }
            });
        })
        .detach();
    }

    /// Sends `text` (without attachments) to the selected thread (or launches the active draft).
    pub(crate) fn send_prompt(&mut self, text: String, cx: &mut Context<'_, Self>) {
        self.send_prompt_with_attachments(
            text,
            Vec::new(),
            crate::chat::SendDispatch::Auto,
            None,
            cx,
        );
    }

    /// Sends `text` and `attachments` to the selected thread over `orchestration.dispatchCommand`,
    /// or launches the active new-thread draft via `orchestration.launchThread`.
    pub(crate) fn send_prompt_with_attachments(
        &mut self,
        text: String,
        attachments: Vec<conn_contract::ChatAttachment>,
        dispatch: crate::chat::SendDispatch,
        window: Option<&mut Window>,
        cx: &mut Context<'_, Self>,
    ) {
        if self.draft.is_some() {
            self.launch_draft(text, attachments, window, cx);
            return;
        }
        let (Some(connection), Some(thread_id)) = (
            self.context_connection(),
            self.layout.selected_thread_id.clone(),
        ) else {
            return;
        };
        let send_window = window.map(|w| w.window_handle());
        self.dispatch_message(
            connection,
            thread_id,
            text,
            attachments,
            dispatch,
            send_window,
            cx,
        );
    }

    /// `message.dispatch` to `thread_id`: steers or queues behind a running turn. A failed send
    /// puts `text` back in the composer.
    #[expect(
        clippy::too_many_arguments,
        reason = "one send's parts, passed straight through"
    )]
    fn dispatch_message(
        &mut self,
        connection: Connection,
        thread_id: String,
        text: String,
        attachments: Vec<conn_contract::ChatAttachment>,
        dispatch: crate::chat::SendDispatch,
        send_window: Option<gpui_kit::AnyWindowHandle>,
        cx: &mut Context<'_, Self>,
    ) {
        let thread = self.threads.get(&thread_id);
        let working = thread.is_some_and(|t| t.working);
        // Steer the running turn when asked (`steer_active`); otherwise queue after it.
        let steer_target = if working && dispatch == crate::chat::SendDispatch::Steer {
            thread.and_then(|t| t.active_run_id().map(str::to_owned))
        } else {
            None
        };
        let command = match crate::commands::send_message(
            &thread_id,
            &text,
            &attachments,
            working,
            steer_target.as_deref(),
        ) {
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
        let fallback_text = text;
        cx.spawn(async move |this, cx| {
            let result = connection.dispatch_command(command).await.map_err(|err| {
                format!(
                    "Send failed: {}",
                    crate::commands::format_client_error(&err)
                )
            });
            if let Err(msg) = result {
                eprintln!("send: dispatchCommand failed: {msg}");
                let _ = this.update(cx, |app, cx| {
                    if app.connection_gen != generation {
                        return;
                    }
                    app.chat.update(cx, |chat, cx| {
                        chat.set_error(Some(msg), cx);
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

    /// A composer send over pending approvals (`useComposerSend`). With feedback support it
    /// declines the first approval with the text as feedback. Otherwise it declines every
    /// answerable approval, then steers with the message. The composer keeps `held` until
    /// then, and the message stays unsent when the draft changed, an approval is already
    /// being answered, a new approval arrived, or the thread changed.
    pub(crate) fn send_over_approvals(
        &mut self,
        text: String,
        attachments: Vec<conn_contract::ChatAttachment>,
        dispatch: crate::chat::SendDispatch,
        held: crate::chat::HeldDraft,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let send_window = Some(window.window_handle());
        let (Some(connection), Some(thread_id), None) = (
            self.context_connection(),
            self.layout.selected_thread_id.clone(),
            self.draft.as_ref(),
        ) else {
            self.chat.update(cx, |chat, cx| {
                chat.settle_held_draft(Some(&held), window, cx)
            });
            self.send_prompt_with_attachments(text, attachments, dispatch, Some(window), cx);
            return;
        };
        let pending = self
            .threads
            .get(&thread_id)
            .map(conn_state::ThreadState::pending_approvals)
            .unwrap_or_default();
        // Approvals the typing guard holds stay unseen and pending (`shownPendingApprovalIds`).
        let pending_before: Vec<String> = pending.iter().map(|a| a.request_id.clone()).collect();
        let approvals: Vec<_> = {
            let held = self.chat.read(cx).held_request_ids();
            pending
                .into_iter()
                .filter(|approval| !held.contains(&approval.request_id))
                .collect()
        };
        let plan = crate::chat::plan_approval_send(&approvals, &text, !attachments.is_empty());
        let feedback_send = matches!(plan, crate::chat::ApprovalSendPlan::Feedback { .. });
        let (shown, declines) = match plan {
            crate::chat::ApprovalSendPlan::Message => {
                self.chat.update(cx, |chat, cx| {
                    chat.settle_held_draft(Some(&held), window, cx)
                });
                self.dispatch_message(
                    connection,
                    thread_id,
                    text,
                    attachments,
                    dispatch,
                    send_window,
                    cx,
                );
                return;
            }
            crate::chat::ApprovalSendPlan::FeedbackNeedsPlainText => {
                self.chat
                    .update(cx, |chat, cx| chat.settle_held_draft(None, window, cx));
                self.chat.update(cx, |chat, cx| {
                    chat.set_error(
                        Some(crate::chat::APPROVAL_FEEDBACK_PLAIN_TEXT.to_owned()),
                        cx,
                    );
                });
                return;
            }
            crate::chat::ApprovalSendPlan::Feedback {
                request_id,
                feedback,
            } => {
                let command = crate::commands::decline_approval_with_feedback(
                    &thread_id,
                    &request_id,
                    &feedback,
                );
                (vec![request_id], command.map(|c| vec![c]))
            }
            crate::chat::ApprovalSendPlan::Redirect { shown, decline } => {
                let commands = decline
                    .iter()
                    .map(|id| crate::commands::respond_approval(&thread_id, id, "decline"))
                    .collect::<Result<Vec<_>, _>>();
                (shown, commands)
            }
        };
        let declines = match declines {
            Ok(declines) => declines,
            Err(e) => {
                eprintln!("send: could not build runtime-request.respond: {e}");
                self.chat
                    .update(cx, |chat, cx| chat.settle_held_draft(None, window, cx));
                return;
            }
        };
        if shown
            .iter()
            .any(|id| self.responding_approvals.contains(id))
        {
            self.chat
                .update(cx, |chat, cx| chat.settle_held_draft(None, window, cx));
            // Conn's feedback send stops silently here; a redirect explains why.
            if !feedback_send
                && let Some(notice) =
                    crate::chat::approval_redirect_notice(false, false, true, false)
            {
                self.show_redirect_notice(notice, cx);
            }
            return;
        }
        self.responding_approvals.extend(shown.iter().cloned());
        self.chat.update(cx, |chat, cx| chat.set_error(None, cx));
        let generation = self.connection_gen;
        cx.spawn(async move |this, cx| {
            let mut declined = Ok(());
            for decline in declines {
                if let Err(err) = connection.dispatch_command(decline).await {
                    declined = Err(format!(
                        "Could not decline the approval: {}",
                        crate::commands::format_client_error(&err)
                    ));
                    break;
                }
            }
            let _ = this.update(cx, |app, cx| {
                for id in &shown {
                    app.responding_approvals.remove(id);
                }
                if app.connection_gen != generation
                    || app.layout.selected_thread_id.as_deref() != Some(thread_id.as_str())
                {
                    app.settle_held_draft(None, send_window, cx);
                    return;
                }
                let draft_changed = app.chat.read(cx).held_draft(cx) != held;
                if feedback_send {
                    // Feedback is the whole answer: clear the draft unless it changed.
                    match declined {
                        Ok(()) => {
                            app.settle_held_draft(Some(&held), send_window, cx);
                        }
                        Err(msg) => {
                            app.settle_held_draft(None, send_window, cx);
                            app.chat
                                .update(cx, |chat, cx| chat.set_error(Some(msg), cx));
                        }
                    }
                    cx.notify();
                    return;
                }
                let arrived = crate::chat::approval_arrived(
                    &pending_before,
                    &app.threads
                        .get(&thread_id)
                        .map(conn_state::ThreadState::pending_approvals)
                        .unwrap_or_default(),
                );
                if declined.is_err() || draft_changed || arrived {
                    app.settle_held_draft(None, send_window, cx);
                    let notice = crate::chat::approval_redirect_notice(
                        draft_changed,
                        declined.is_ok(),
                        false,
                        arrived,
                    );
                    match (notice, declined) {
                        (Some(notice), _) => app.show_redirect_notice(notice, cx),
                        (None, Err(msg)) => {
                            app.chat
                                .update(cx, |chat, cx| chat.set_error(Some(msg), cx));
                        }
                        (None, Ok(())) => {}
                    }
                    cx.notify();
                    return;
                }
                app.settle_held_draft(Some(&held), send_window, cx);
                app.dispatch_message(
                    connection,
                    thread_id,
                    text,
                    attachments,
                    dispatch,
                    send_window,
                    cx,
                );
            });
        })
        .detach();
    }

    /// Ends an approval send in the composer; `clear` empties it when its draft is unchanged.
    fn settle_held_draft(
        &self,
        clear: Option<&crate::chat::HeldDraft>,
        window: Option<gpui_kit::AnyWindowHandle>,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(window) = window else {
            return;
        };
        let chat = self.chat.clone();
        let _ = window.update(cx, |_, window, cx| {
            chat.update(cx, |chat, cx| chat.settle_held_draft(clear, window, cx))
        });
    }

    /// Shows why a redirect kept the draft. Conn uses an info toast; this client has no toasts,
    /// so the composer's dismissible banner carries it.
    fn show_redirect_notice(&self, notice: &str, cx: &mut Context<'_, Self>) {
        let message = format!("{notice} {}", crate::chat::APPROVAL_REDIRECT_RETRY);
        self.chat
            .update(cx, |chat, cx| chat.set_error(Some(message), cx));
    }

    /// Answers the approval timeline entry `entry_id` of the selected thread. A failure goes back
    /// to its card, which then answers again.
    pub(crate) fn respond_approval(
        &mut self,
        entry_id: &str,
        decision: &str,
        cx: &mut Context<'_, Self>,
    ) {
        let (Some(connection), Some(thread_id)) = (
            self.context_connection(),
            self.layout.selected_thread_id.clone(),
        ) else {
            self.approval_failed(entry_id, "Not connected. Try again.".to_owned(), cx);
            return;
        };
        let Some(request_id) = self
            .threads
            .get(&thread_id)
            .and_then(|t| t.approval_requests.get(entry_id))
            .cloned()
        else {
            eprintln!("approval: no request id for entry {entry_id}");
            self.approval_failed(
                entry_id,
                "This approval is no longer waiting.".to_owned(),
                cx,
            );
            return;
        };
        let command = match crate::commands::respond_approval(&thread_id, &request_id, decision) {
            Ok(command) => command,
            Err(e) => {
                eprintln!("approval: could not build runtime-request.respond: {e}");
                self.approval_failed(entry_id, "Could not answer the approval.".to_owned(), cx);
                return;
            }
        };
        // A composer send meanwhile must not decline this request too (`respondingRequestIds`).
        if !self.responding_approvals.insert(request_id.clone()) {
            self.approval_failed(
                entry_id,
                "Another answer to this approval is on its way.".to_owned(),
                cx,
            );
            return;
        }
        let entry_id = entry_id.to_owned();
        cx.spawn(async move |this, cx| {
            let result = connection.dispatch_command(command).await;
            let _ = this.update(cx, |app, cx| {
                app.responding_approvals.remove(&request_id);
                if let Err(e) = result {
                    eprintln!("approval: dispatchCommand failed: {e}");
                    app.approval_failed(&entry_id, crate::commands::format_client_error(&e), cx);
                }
            });
        })
        .detach();
    }

    /// Tells the approval card of `entry_id` that its answer did not go through.
    fn approval_failed(&mut self, entry_id: &str, message: String, cx: &mut Context<'_, Self>) {
        self.chat.update(cx, |chat, cx| {
            chat.approval_response_failed(entry_id, message, cx)
        });
    }

    /// Forks the selected thread at `run_id` into a new thread and opens it
    /// (Conn `onForkFromRun` -> `forkThreadFromRun`).
    pub(crate) fn fork_selected_from_run(&mut self, run_id: &str, cx: &mut Context<'_, Self>) {
        let (Some(connection), Some(source_thread_id)) = (
            self.context_connection(),
            self.layout.selected_thread_id.clone(),
        ) else {
            return;
        };
        let target_thread_id = crate::commands::new_thread_id();
        let command = match crate::commands::fork_thread_from_run(
            &source_thread_id,
            &target_thread_id,
            run_id,
        ) {
            Ok(command) => command,
            Err(e) => {
                eprintln!("fork: could not build thread.fork: {e}");
                return;
            }
        };
        cx.spawn(async move |this, cx| {
            let result = connection.dispatch_command(command).await;
            let _ = this.update(cx, |app, cx| match result {
                Ok(_) => app.select_thread(target_thread_id, cx),
                Err(err) => {
                    let message = crate::commands::format_client_error(&err);
                    app.chat
                        .update(cx, |chat, cx| chat.set_error(Some(message), cx));
                }
            });
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
            self.context_connection(),
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
            self.context_connection(),
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

    /// Promotes a queued message to steer the active turn, or starts it immediately when stopped.
    pub(crate) fn promote_queued_message(&mut self, run_id: &str, cx: &mut Context<'_, Self>) {
        let (Some(connection), Some(thread_id)) = (
            self.context_connection(),
            self.layout.selected_thread_id.clone(),
        ) else {
            return;
        };
        let active_run_id = self
            .threads
            .get(&thread_id)
            .and_then(|t| t.active_run_id().map(str::to_owned));
        let command = match active_run_id {
            Some(target_run_id) => {
                crate::commands::promote_queued_to_steer(&thread_id, run_id, &target_run_id)
            }
            None => crate::commands::start_queued_run(&thread_id, run_id),
        };
        let command = match command {
            Ok(cmd) => cmd,
            Err(err) => {
                eprintln!("queue: could not build send-now command: {err}");
                self.chat.update(cx, |chat, cx| {
                    chat.set_error(Some(format!("Could not send queued message: {err}")), cx);
                });
                return;
            }
        };
        let generation = self.connection_gen;
        cx.spawn(async move |this, cx| {
            if let Err(err) = connection.dispatch_command(command).await {
                let msg = crate::commands::format_client_error(&err);
                eprintln!("queue: send-now dispatchCommand failed: {msg}");
                let _ = this.update(cx, |app, cx| {
                    if app.connection_gen != generation {
                        return;
                    }
                    app.chat.update(cx, |chat, cx| {
                        chat.set_error(Some(format!("Send now failed: {msg}")), cx);
                    });
                });
            }
        })
        .detach();
    }

    /// Removes a queued message from the selected thread's queue (`queued-run.cancel`).
    pub(crate) fn cancel_queued_message(&mut self, run_id: &str, cx: &mut Context<'_, Self>) {
        let (Some(connection), Some(thread_id)) = (
            self.context_connection(),
            self.layout.selected_thread_id.clone(),
        ) else {
            return;
        };
        let command = match crate::commands::cancel_queued_run(&thread_id, run_id) {
            Ok(cmd) => cmd,
            Err(err) => {
                eprintln!("queue: could not build queued-run.cancel: {err}");
                return;
            }
        };
        let generation = self.connection_gen;
        cx.spawn(async move |this, cx| {
            if let Err(err) = connection.dispatch_command(command).await {
                let msg = crate::commands::format_client_error(&err);
                eprintln!("queue: queued-run.cancel failed: {msg}");
                let _ = this.update(cx, |app, cx| {
                    if app.connection_gen != generation {
                        return;
                    }
                    app.chat.update(cx, |chat, cx| {
                        chat.set_error(Some(format!("Could not remove queued message: {msg}")), cx);
                    });
                });
            }
        })
        .detach();
    }

    /// Saves edits to a queued message (`queued-run.edit`).
    pub(crate) fn edit_queued_message(
        &mut self,
        run_id: &str,
        text: &str,
        attachments: Option<&[conn_contract::ChatAttachment]>,
        cx: &mut Context<'_, Self>,
    ) {
        let (Some(connection), Some(thread_id)) = (
            self.context_connection(),
            self.layout.selected_thread_id.clone(),
        ) else {
            return;
        };
        let command = match crate::commands::edit_queued_run(&thread_id, run_id, text, attachments)
        {
            Ok(cmd) => cmd,
            Err(err) => {
                eprintln!("queue: could not build queued-run.edit: {err}");
                self.chat.update(cx, |chat, cx| {
                    chat.set_error(Some(format!("Could not update queued message: {err}")), cx);
                });
                return;
            }
        };
        let generation = self.connection_gen;
        cx.spawn(async move |this, cx| {
            if let Err(err) = connection.dispatch_command(command).await {
                let msg = crate::commands::format_client_error(&err);
                eprintln!("queue: queued-run.edit failed: {msg}");
                let _ = this.update(cx, |app, cx| {
                    if app.connection_gen != generation {
                        return;
                    }
                    app.chat.update(cx, |chat, cx| {
                        chat.set_error(Some(format!("Could not update queued message: {msg}")), cx);
                    });
                });
            }
        })
        .detach();
    }

    /// Opens the Browser tab and loads `url`.
    #[cfg(feature = "automation")]
    pub(crate) fn browse(&mut self, url: String, cx: &mut Context<'_, Self>) {
        let surface = self.right_panel_tabs.open(RightPanelTab::Browser);
        self.show_right_panel_surface(cx);
        if let PanelSurface::Browser(id) = surface {
            self.right_panel
                .update(cx, |panel, cx| panel.navigate_browser(id, url, cx));
        }
    }

    /// Opens `url` in a new browser tab (`openUrlInPreview`): it shows, unless `background`
    /// keeps the tab behind the active one.
    pub(crate) fn open_browser_tab(
        &mut self,
        url: String,
        background: bool,
        cx: &mut Context<'_, Self>,
    ) {
        let id = if background {
            self.right_panel_tabs.new_background_browser()
        } else {
            self.right_panel_tabs.new_browser()
        };
        self.right_panel
            .update(cx, |panel, cx| panel.navigate_browser(id, url, cx));
        if background && self.layout.right_panel_open {
            self.save_thread_panels(cx);
            cx.notify();
        } else {
            self.show_right_panel_surface(cx);
        }
    }

    /// Diagnostic state of the shown thread's browser tab.
    #[cfg(feature = "automation")]
    pub(crate) fn browser_state(
        &mut self,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Result<serde_json::Value, String> {
        let id = self.thread_browser();
        self.right_panel
            .update(cx, |panel, cx| panel.browser_state(id, window, cx))
    }

    /// The shown thread's browser tab's page title.
    #[cfg(feature = "automation")]
    pub(crate) fn browser_title(
        &mut self,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Result<String, String> {
        let id = self.thread_browser();
        self.right_panel
            .update(cx, |panel, cx| panel.browser_title(id, window, cx))
    }

    #[cfg(feature = "automation")]
    pub(crate) fn browser_preview_eval(
        &mut self,
        expression: &str,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Result<tokio::sync::oneshot::Receiver<Result<serde_json::Value, String>>, String> {
        let id = self.thread_browser();
        self.right_panel.update(cx, |panel, cx| {
            panel.browser_preview_eval(id, expression, window, cx)
        })
    }

    #[cfg(feature = "automation")]
    pub(crate) fn browser_preview_call(
        &mut self,
        op: &str,
        params: &serde_json::Value,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Result<tokio::sync::oneshot::Receiver<Result<serde_json::Value, String>>, String> {
        let id = self.thread_browser();
        self.right_panel.update(cx, |panel, cx| {
            panel.browser_preview_call(id, op, params, window, cx)
        })
    }

    #[cfg(feature = "automation")]
    pub(crate) fn browser_screenshot(
        &mut self,
        path: &std::path::Path,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Result<serde_json::Value, String> {
        let id = self.thread_browser();
        self.right_panel.update(cx, |panel, cx| {
            panel.browser_screenshot(id, path, window, cx)
        })
    }

    /// State read-out for the automation hook.
    #[cfg(feature = "automation")]
    pub(crate) fn automation_dump(&self, cx: &App) -> serde_json::Value {
        let timeline = self.selected_timeline().map(|t| {
            serde_json::json!({
                "working": t.working,
                "synchronized": t.synchronized,
                "entryCount": t.entries.len(),
                "messageIds": t.entries.iter().filter(|entry|matches!(entry,conn_state::TimelineEntry::User{..}|conn_state::TimelineEntry::Assistant{..})).map(conn_state::TimelineEntry::id).collect::<Vec<_>>(),
                "entries": t.entries.iter().take(20).map(|e| format!("{e:?}").chars().take(120).collect::<String>()).collect::<Vec<_>>(),
            })
        });
        let chat_metrics = self.chat.read(cx).timeline_metrics();
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
            "chatMetrics": chat_metrics,
            "palette": self.command_palette.is_some(),
            "settings": self.settings_modal.is_some(),
        })
    }

    /// Automation-only: seeds a synthetic large multi-turn thread in memory to benchmark
    /// virtualized list rendering, lazy Markdown parsing, and TOC navigation.
    #[cfg(feature = "automation")]
    pub(crate) fn automation_seed_big_thread(
        &mut self,
        turns: usize,
        cx: &mut Context<'_, Self>,
    ) -> serde_json::Value {
        use conn_state::{
            EntryTiming, ItemStatus, RunTiming, ThreadState, TimelineEntry, TurnCheckpointSummary,
        };

        let turns = turns.clamp(2, 500);
        let thread_id = format!("big-thread-{turns}");
        let mut state = ThreadState::new(thread_id.clone());
        state.synchronized = true;

        let topics = [
            "Audit virtualized timeline scrolling in GPUI",
            "Inspect Antigravity compact snapshot hydration",
            "Refactor Orbit Gateway async pairing flow",
            "Verify Dark Ocean vibrancy shell tokens",
            "Optimize markdown code block syntax highlighting",
            "Check WebSocket 512 MiB frame limit",
            "Profile thread switch latency across large histories",
            "Add side message TOC navigator with hover preview",
        ];

        for turn in 1..=turns {
            let topic = topics[(turn - 1) % topics.len()];
            let run_id = format!("big-run-{turn}");
            let start_ms = 1_700_000_000_000_i64 + (turn as i64) * 15_000;
            state.run_timings.insert(
                run_id.clone(),
                RunTiming {
                    started_at_ms: Some(start_ms),
                    completed_at_ms: Some(start_ms + 4_200),
                },
            );

            state.entries.push(TimelineEntry::User {
                id: format!("big-u-{turn}"),
                text: format!("Turn #{turn}: {topic} and verify edge cases."),
                created_by_agent: false,
                created_at: None,
                attachments: Vec::new(),
                is_steer: false,
                review_comments: Vec::new(),
                run_id: None,
            });

            // Simulate realistic agent work (thinking + 3 tools) per turn.
            let think_id = format!("big-th-{turn}");
            state.entries.push(TimelineEntry::Thinking {
                id: think_id.clone(),
                text: format!("Analyzing turn #{turn} requirements for {topic}."),
                streaming: false,
            });
            state.entry_timings.insert(
                think_id,
                EntryTiming {
                    run_id: Some(run_id.clone()),
                    started_at_ms: Some(start_ms),
                    completed_at_ms: Some(start_ms + 900),
                },
            );

            for step in 1..=3 {
                let tool_id = format!("big-tool-{turn}-{step}");
                let failed = turn % 19 == 0 && step == 2;
                state.entries.push(TimelineEntry::Tool {
                    id: tool_id.clone(),
                    kind: match step {
                        1 => "file_read",
                        2 => "command",
                        _ => "file_change",
                    }
                    .to_owned(),
                    title: match step {
                        1 => format!("Read crates/conn-app/src/chat/mod.rs (turn {turn})"),
                        2 => format!("Run cargo test -p conn-app -- turn_{turn}"),
                        _ => format!("Edit crates/conn-app/src/chat/cache.rs (turn {turn})"),
                    },
                    detail: Some(format!(
                        "Simulated tool output for turn {turn} step {step}.\nAll checks completed."
                    )),
                    status: if failed {
                        ItemStatus::Failed
                    } else {
                        ItemStatus::Completed
                    },
                    output_omitted: false,
                });
                state.entry_timings.insert(
                    tool_id,
                    EntryTiming {
                        run_id: Some(run_id.clone()),
                        started_at_ms: Some(start_ms + (step as i64) * 900),
                        completed_at_ms: Some(start_ms + (step as i64) * 900 + 800),
                    },
                );
            }

            let asst_id = format!("big-a-{turn}");
            state.entries.push(TimelineEntry::Assistant {
                id: asst_id.clone(),
                markdown: format!(
                    "### Turn #{turn} Summary — {topic}\n\n\
                     Completed the update cleanly with lazy Markdown parsing and virtualized list rows.\n\n\
                     ```rust\n\
                     pub fn handle_turn_{turn}(items: usize) -> usize {{\n\
                         items.saturating_sub(1)\n\
                     }}\n\
                     ```\n\n\
                     - Verified **zero eager parse** for offscreen rows.\n\
                     - Checked `ListState::splice` anchor stability."
                ),
                streaming: false,
                created_at: None,
                run_id: Some(run_id.clone()),
                status: conn_state::ItemStatus::Completed,
            });
            state.entry_timings.insert(
                asst_id,
                EntryTiming {
                    run_id: Some(run_id.clone()),
                    started_at_ms: Some(start_ms + 3_500),
                    completed_at_ms: Some(start_ms + 4_200),
                },
            );

            if turn % 5 == 0 {
                state.turn_checkpoints.insert(
                    run_id.clone(),
                    TurnCheckpointSummary {
                        run_id,
                        app_run_ordinal: Some(turn as i64),
                        file_count: 2 + (turn % 4),
                        additions: (18 + turn) as i64,
                        deletions: (4 + (turn % 7)) as i64,
                        files: Vec::new(),
                    },
                );
            }
        }

        let entry_count = state.entries.len();
        self.threads.insert(thread_id.clone(), state);
        self.layout.selected_thread_id = Some(thread_id.clone());
        self.park_active_draft();

        let t0 = std::time::Instant::now();
        self.sync_chat(cx);
        let sync_ms = t0.elapsed().as_secs_f64() * 1000.0;
        cx.notify();

        let metrics = self.chat.read(cx).timeline_metrics();
        serde_json::json!({
            "threadId": thread_id,
            "turns": turns,
            "entryCount": entry_count,
            "syncMs": (sync_ms * 100.0).round() / 100.0,
            "chatMetrics": metrics,
        })
    }

    /// Automation-only: pins/unpins the chat TOC popover.
    #[cfg(feature = "automation")]
    pub(crate) fn automation_set_toc_open(
        &mut self,
        open: bool,
        cx: &mut Context<'_, Self>,
    ) -> serde_json::Value {
        self.chat
            .update(cx, |chat, cx| chat.set_toc_pinned(open, cx));
        serde_json::to_value(self.chat.read(cx).timeline_metrics())
            .unwrap_or(serde_json::Value::Null)
    }

    /// Automation-only: jumps the chat timeline to 1-based user turn `turn`.
    #[cfg(feature = "automation")]
    pub(crate) fn automation_toc_jump(
        &mut self,
        turn: usize,
        cx: &mut Context<'_, Self>,
    ) -> Result<serde_json::Value, String> {
        let item_index = self
            .chat
            .update(cx, |chat, cx| chat.jump_to_toc_turn(turn, cx))?;
        Ok(serde_json::json!({
            "turn": turn,
            "itemIndex": item_index,
            "chatMetrics": self.chat.read(cx).timeline_metrics(),
        }))
    }

    /// Automation-only: jumps the chat timeline back to the live tail.
    #[cfg(feature = "automation")]
    pub(crate) fn automation_scroll_latest(
        &mut self,
        cx: &mut Context<'_, Self>,
    ) -> serde_json::Value {
        self.chat.update(cx, |chat, cx| chat.scroll_to_latest(cx));
        serde_json::to_value(self.chat.read(cx).timeline_metrics())
            .unwrap_or(serde_json::Value::Null)
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
        // Opening a thread ends a selection, and anchors the next `Shift`-click (`navigateToThread`).
        self.thread_selection.clear();
        self.thread_selection.set_anchor(&thread_id);
        // A thread the project filter hides widens the filter to every project, and its row
        // scrolls into view (`routeReveal`).
        if let Some(project_id) = &project_id
            && self.active_workspace.is_some()
            && !crate::sidebar::thread_list::project_in_scope(
                &self.shell,
                &self.orbit.workspaces,
                self.active_workspace.as_deref(),
                project_id,
            )
        {
            self.active_workspace = None;
            rail_workspaces::save_active_workspace(None);
        }
        self.reveal_open_row = true;
        self.open_thread(thread_id);
        if project_id.is_some() {
            self.layout.selected_project_id = project_id;
        }
        self.chat.update(cx, |chat, cx| chat.set_error(None, cx));
        self.sync_chat(cx);
        if self.thread_details.open {
            self.refresh_thread_details(cx);
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
        self.sync_browser_visibility(cx);
        self.save_thread_panels(cx);
        cx.notify();
    }

    /// Fills the window with the right panel, or gives the chat its column back.
    pub(crate) fn toggle_right_panel_maximized(&mut self, cx: &mut Context<'_, Self>) {
        self.right_panel_maximized = !self.right_panel_maximized;
        self.save_thread_panels(cx);
        cx.notify();
    }

    /// Opens or closes the terminal drawer under the chat (`terminal.toggle`, `Cmd+J`). Opening
    /// starts the shell on first use and focuses it; closing returns focus to the shell root.
    pub(crate) fn toggle_terminal_drawer(
        &mut self,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.terminal_drawer_open = !self.terminal_drawer_open;
        let terminal = self.right_panel.read(cx).terminal_entity();
        if self.terminal_drawer_open {
            terminal.update(cx, |terminal, cx| {
                terminal.ensure_started(cx);
                terminal.focus(window, cx);
            });
        } else {
            self.seam_drag = None;
            window.focus(&self.focus_handle, cx);
        }
        self.save_thread_panels(cx);
        cx.notify();
    }

    /// Starts dragging the terminal drawer's top edge from pointer height `y`.
    pub(crate) fn begin_terminal_drawer_drag(&mut self, y: f32, cx: &mut Context<'_, Self>) {
        self.seam_drag = Some(SeamDrag::TerminalDrawer {
            from_y: y,
            start: self.terminal_drawer_height,
        });
        cx.notify();
    }

    /// Resets the terminal drawer to its default height (double-click on its handle).
    pub(crate) fn reset_terminal_drawer_height(&mut self, cx: &mut Context<'_, Self>) {
        self.terminal_drawer_height = TERMINAL_DRAWER_DEFAULT_PX;
        self.seam_drag = None;
        cx.notify();
    }

    /// The open right panel has no tab, so it lists the surfaces to open.
    fn right_panel_shows_launcher(&self) -> bool {
        self.layout
            .shows_surface_launcher(self.right_panel_tabs.tabs().len())
    }

    /// Puts the shown thread's (or draft's) right panel in place. Panels are keyed by environment
    /// and thread or draft id: two environments can hold the same thread id. The panel it leaves
    /// keeps its tabs, and its browsers keep their pages, until the thread shows again.
    /// Its maximize state, terminal drawer and width go with it. `true` when the owner changed.
    fn sync_panel_owner(&mut self) -> bool {
        let owner = match (&self.layout.selected_thread_id, &self.draft) {
            (Some(thread), _) => Some(self.panel_owner_of_thread(thread)),
            (None, Some(draft)) => {
                Some(self.panel_owner_of_draft(&draft.draft_id, &draft.project_id))
            }
            (None, None) => None,
        };
        let mut panel = ThreadPanel {
            tabs: std::mem::take(&mut self.right_panel_tabs),
            open: self.layout.right_panel_open,
            maximized: self.right_panel_maximized,
            terminal_open: self.terminal_drawer_open,
            width: Some(self.layout.right_panel_width),
        };
        let switched = self.thread_panels.switch(owner, &mut panel);
        if switched {
            self.right_panel_add_menu_open = false;
            self.seam_drag = None;
            self.layout.right_panel_tab = panel
                .tabs
                .active()
                .map_or(RightPanelTab::Files, PanelSurface::kind);
            if let Some(width) = panel.width {
                self.layout.set_right_panel_width(width);
            }
        }
        self.right_panel_tabs = panel.tabs;
        self.layout.right_panel_open = panel.open;
        self.right_panel_maximized = panel.maximized;
        self.terminal_drawer_open = panel.terminal_open;
        switched
    }

    /// An agent's `panel_open` for a thread the user is not looking at: its tab waits in that
    /// thread's panel (`preparePanel`), and nothing reaches the shown thread's panel. SQL waits
    /// in that thread's Database editor (`openDatabaseQuery`). Running it, or an MCP action,
    /// needs the panel on screen, so it does not run and the agent hears why. Returns that.
    fn prepare_background_panel(
        &mut self,
        owner: &PanelOwner,
        request: &conn_contract::AgentPanelRequest,
        not_on_thread: &str,
        cx: &mut Context<'_, Self>,
    ) -> Option<String> {
        use conn_contract::AgentPanelKind;
        if request.panel == AgentPanelKind::Mcp
            && (request.mcp_server.is_some() || request.mcp_call.is_some())
        {
            return Some(not_on_thread.to_owned());
        }
        let mut error = None;
        if request.panel == AgentPanelKind::Database
            && let Some(sql) = request.sql.clone()
        {
            if let Err(refused) = self
                .right_panel
                .update(cx, |panel, cx| panel.set_database_sql(owner, sql, cx))
            {
                return Some(refused);
            }
            if request.run == Some(true) {
                error = Some(format!(
                    "{not_on_thread} The query is in its Database panel."
                ));
            }
        }
        self.thread_panels.prepare(
            owner,
            agent_panel_tab(request.panel),
            &mut self.right_panel_tabs,
        );
        self.save_thread_panels(cx);
        error
    }

    /// Whose panel an agent's request for `thread` from `origin` reaches. The primary's needs
    /// its environment id confirmed by the server since it last connected: a request that
    /// arrives before is refused, never filed under a guessed id.
    fn request_owner(&self, origin: &PanelOrigin, thread: &str) -> Result<PanelOwner, String> {
        match origin {
            PanelOrigin::Linked(environment) => Ok(PanelOwner::new(environment.clone(), thread)),
            PanelOrigin::Primary => match (&self.primary_environment, self.primary_confirmed) {
                (Some(environment), true) => Ok(PanelOwner::new(environment.clone(), thread)),
                _ => Err(PRIMARY_NOT_READY.to_owned()),
            },
        }
    }

    /// Whose right panel thread `thread` shows: the thread on its own environment.
    fn panel_owner_of_thread(&self, thread: &str) -> PanelOwner {
        let environment = self
            .linked_environment_of_thread(thread)
            .map_or_else(|| self.primary_panel_environment(), str::to_owned);
        PanelOwner::new(environment, thread)
    }

    /// Whose right panel draft `draft` shows: the draft on its project's environment.
    fn panel_owner_of_draft(&self, draft: &str, project_id: &str) -> PanelOwner {
        let environment = self
            .linked_environment_of_project(project_id)
            .map_or_else(|| self.primary_panel_environment(), str::to_owned);
        PanelOwner::new(environment, draft)
    }

    /// The shown thread's browser tab for the automation hook: the active one, else the one it
    /// showed last. None when this thread has no browser tab, whatever other threads hold.
    #[cfg(feature = "automation")]
    fn thread_browser(&self) -> Option<conn_state::BrowserTabId> {
        match self.right_panel_tabs.active() {
            Some(PanelSurface::Browser(id)) => Some(*id),
            _ => self.right_panel_tabs.last_browser(),
        }
    }

    /// A thread deleted here takes its right panel and browsers with it. Shell events do not:
    /// `thread.removed` also means archived, and the thread can come back. The browser cap
    /// bounds what threads deleted elsewhere leave behind.
    pub(crate) fn release_thread_panel(&mut self, owner: &PanelOwner, cx: &mut Context<'_, Self>) {
        self.sync_panel_owner();
        self.forget_thread_panel(owner, cx);
    }

    /// A deleted thread's right panel goes with it, and so do its browsers, its waiting
    /// Database query and its saved layout.
    fn forget_thread_panel(&mut self, owner: &PanelOwner, cx: &mut Context<'_, Self>) {
        let browsers = self.thread_panels.forget(owner);
        self.right_panel.update(cx, |panel, cx| {
            for id in browsers {
                panel.close_surface(&PanelSurface::Browser(id), cx);
            }
            panel.forget_owner(owner, cx);
        });
        self.save_thread_panels(cx);
    }

    #[cfg(test)]
    pub(crate) fn open_draft_id_for_test(&self) -> Option<String> {
        self.draft.as_ref().map(|d| d.draft_id.clone())
    }

    #[cfg(test)]
    pub(crate) fn right_panel_add_menu_open_for_test(&self) -> bool {
        self.right_panel_add_menu_open
    }

    #[cfg(test)]
    pub(crate) fn right_panel_shows_launcher_for_test(&self) -> bool {
        self.right_panel_shows_launcher()
    }

    #[cfg(test)]
    pub(crate) fn right_panel_for_test(&self) -> &Entity<crate::panels::RightPanel> {
        &self.right_panel
    }

    /// One server event, applied as the connection's batch loop applies it.
    #[cfg(test)]
    pub(crate) fn apply_event_for_test(&mut self, event: ClientEvent, cx: &mut Context<'_, Self>) {
        self.apply_event(event, None, cx);
        self.sync_chat(cx);
        cx.notify();
    }

    /// What a server switch does to the app's state, without opening a connection.
    #[cfg(test)]
    pub(crate) fn switch_server_state_for_test(&mut self, cx: &mut Context<'_, Self>) {
        self.reset_environment_state();
        self.sync_chat(cx);
        cx.notify();
    }

    /// An agent's panel request from `environment` (`None`: the primary connection), through
    /// the same dispatch as a connection's; the answer comes back on the receiver.
    #[cfg(test)]
    pub(crate) fn dispatch_agent_panel_request_for_test(
        &self,
        request: conn_contract::AgentPanelRequest,
        environment: Option<&str>,
        cx: &mut Context<'_, Self>,
    ) -> tokio::sync::oneshot::Receiver<conn_contract::source::DesktopPanelResponse> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let origin =
            environment.map_or(PanelOrigin::Primary, |e| PanelOrigin::Linked(e.to_owned()));
        let request = conn_contract::source::DesktopPanelRequest {
            panel: request,
            files_action: None,
        };
        self.dispatch_agent_panel_request(request, origin, PanelReply::Test(tx), cx);
        rx
    }

    #[cfg(test)]
    pub(crate) fn prepare_background_panel_for_test(
        &mut self,
        request: &conn_contract::AgentPanelRequest,
        cx: &mut Context<'_, Self>,
    ) -> Option<String> {
        let owner = self.panel_owner_of_thread(&request.thread_id);
        self.prepare_background_panel(&owner, request, "not on thread", cx)
    }

    /// The panel owner of thread `thread`, as requests and the Database panel key it.
    #[cfg(test)]
    pub(crate) fn panel_owner_for_test(&self, thread: &str) -> PanelOwner {
        self.panel_owner_of_thread(thread)
    }

    #[cfg(test)]
    pub(crate) fn right_panel_tabs(&self) -> &RightPanelTabs {
        &self.right_panel_tabs
    }

    /// Maximized, terminal drawer open, and the panel's width.
    #[cfg(test)]
    pub(crate) fn right_panel_state_for_test(&self) -> (bool, bool, f32) {
        (
            self.right_panel_maximized,
            self.terminal_drawer_open,
            self.layout.right_panel_width,
        )
    }

    /// The drawer flag and width as a toggle and a seam drag leave them, without a shell.
    #[cfg(test)]
    pub(crate) fn set_drawer_and_width_for_test(&mut self, drawer: bool, width: f32) {
        self.terminal_drawer_open = drawer;
        self.layout.set_right_panel_width(width);
    }

    #[cfg(test)]
    pub(crate) fn browser_weak_for_test(
        &self,
        id: conn_state::BrowserTabId,
        cx: &App,
    ) -> Option<gpui_kit::WeakEntity<crate::panels::BrowserPanelHandle>> {
        self.right_panel.read(cx).browser_handle(id)
    }

    /// The address browser tab `id` loads, once its browser exists.
    #[cfg(test)]
    pub(crate) fn browser_target_for_test(
        &self,
        id: conn_state::BrowserTabId,
        cx: &App,
    ) -> Option<String> {
        self.right_panel.read(cx).browser_target(id, cx)
    }

    /// The active right-panel surface.
    /// With no tab open it is never a browser: the right panel holds other threads' browsers,
    /// and an empty thread shows the launcher, not one of them.
    fn right_panel_surface(&self) -> PanelSurface {
        let fallback = match self.layout.right_panel_tab {
            RightPanelTab::Browser => RightPanelTab::Files,
            tab => tab,
        };
        self.right_panel_tabs
            .active()
            .cloned()
            .unwrap_or(PanelSurface::Kind(fallback))
    }

    #[cfg(feature = "automation")]
    pub(crate) fn spike_files_state(&self, window: &Window, cx: &App) -> serde_json::Value {
        let mut state = self.right_panel.read(cx).spike_files_state(window, cx);
        if let PanelSurface::File(path) = self.right_panel.read(cx).displayed_surface(
            self.right_panel_surface(),
            self.right_panel_tabs.tabs(),
            cx,
        ) {
            state["displayedTab"] = path.into();
        }
        state["composerFocused"] = self.chat.read(cx).spike_input_focused(window, cx).into();
        state
    }

    pub(crate) fn show_source_location(
        &mut self,
        location: &conn_contract::source::SourceLocation,
        cx: &mut Context<'_, Self>,
    ) {
        self.select_right_panel_surface(PanelSurface::File(location.path.clone()), cx);
        if let Some(lines) = location.lines {
            self.right_panel.update(cx, |panel, cx| {
                panel.reveal_lines(location.path.clone(), lines, None, cx)
            });
        }
    }

    /// Selects a right-panel tab and opens the right panel if it was closed. Browser shows the
    /// browser tab shown last, or a new one (`togglePreviewPanel`).
    pub(crate) fn select_right_panel_tab(
        &mut self,
        tab: RightPanelTab,
        cx: &mut Context<'_, Self>,
    ) {
        self.right_panel_tabs.open(tab);
        self.show_right_panel_surface(cx);
    }

    /// The add menu's choice (`+`, its letter keys, the launcher): Browser always adds a new
    /// tab (`createBrowserSurface`); other kinds show their one tab.
    pub(crate) fn add_right_panel_tab(&mut self, tab: RightPanelTab, cx: &mut Context<'_, Self>) {
        self.right_panel_tabs.add(tab);
        self.show_right_panel_surface(cx);
    }

    /// Shows `surface` (opening its tab) and opens the right panel if it was closed.
    pub(crate) fn select_right_panel_surface(
        &mut self,
        surface: PanelSurface,
        cx: &mut Context<'_, Self>,
    ) {
        self.right_panel_tabs.activate(surface);
        self.show_right_panel_surface(cx);
    }

    /// Opens the right panel on the active tab.
    fn show_right_panel_surface(&mut self, cx: &mut Context<'_, Self>) {
        self.right_panel_add_menu_open = false;
        self.layout.right_panel_tab = self.right_panel_surface().kind();
        self.layout.right_panel_open = true;
        self.sync_chat(cx);
        self.sync_browser_visibility(cx);
        self.save_thread_panels(cx);
        cx.notify();
    }

    /// A dialog, menu or popover is open, so a panel shortcut must leave the keyboard where it is
    /// (`LAUNCHER_SHORTCUT_BLOCKING_LAYERS` in `RightPanelTabs.tsx`).
    fn shortcut_blocking_layer_open(&self, cx: &App) -> bool {
        self.settings_modal.is_some()
            || self.command_palette.is_some()
            || self.workspace_editor.is_some()
            || self.thread_menu.is_some()
            || self.rail_menu.is_some()
            || self.sidebar_filter_menu_open
            || self.chat.read(cx).model_picker_open(cx)
    }

    /// `rightPanel.new` (`Cmd+T`): opens the `+` menu while the right panel shows and the
    /// terminal does not have the keyboard.
    fn open_right_panel_add_menu(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let terminal = self.right_panel.read(cx).terminal_entity();
        let terminal_focused = terminal.focus_handle(cx).contains_focused(window, cx);
        let blocked = !self.right_panel_add_menu_open && self.shortcut_blocking_layer_open(cx);
        if !self.layout.right_panel_open || terminal_focused || blocked {
            cx.propagate();
            return;
        }
        if !self.right_panel_add_menu_open {
            self.right_panel_add_menu_open = true;
            window.focus(&self.focus_handle, cx);
            cx.notify();
        }
    }

    /// Closes a right panel tab (`closeSurface`); closing the last one closes the panel.
    pub(crate) fn close_right_panel_tab(
        &mut self,
        surface: &PanelSurface,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(closed) = self.right_panel_tabs.close(surface) else {
            return;
        };
        self.right_panel
            .update(cx, |panel, cx| panel.close_surface(surface, cx));
        if closed.was_last {
            self.right_panel_add_menu_open = false;
            if self.layout.right_panel_open {
                self.toggle_right_panel(cx);
            }
            self.save_thread_panels(cx);
            cx.notify();
        } else if closed.activated.is_some() {
            self.show_right_panel_surface(cx);
        } else {
            self.save_thread_panels(cx);
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
            self.right_panel_maximized = false;
            self.sync_chat(cx);
            self.sync_browser_visibility(cx);
            self.save_thread_panels(cx);
            cx.notify();
        } else {
            self.select_right_panel_tab(tab, cx);
        }
    }

    /// Replaces the shell snapshot (projects and threads).
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "programmatic state hook for conn-client snapshots and future automation"
        )
    )]
    pub(crate) fn set_shell(&mut self, shell: ShellState, cx: &mut Context<'_, Self>) {
        self.shell = shell;
        cx.notify();
    }

    /// Stages local file paths into the active thread composer (used by automation and tests).
    #[cfg(any(test, feature = "automation"))]
    pub(crate) fn attach_paths_to_composer(
        &mut self,
        paths: Vec<std::path::PathBuf>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.chat
            .update(cx, |chat, cx| chat.attach_paths(paths, window, cx));
    }

    /// Test helper: injects a synthetic [`ThreadState`], selects it, and syncs the chat timeline.
    #[cfg(test)]
    pub(crate) fn set_thread_for_test(
        &mut self,
        thread_id: String,
        thread: ThreadState,
        cx: &mut Context<'_, Self>,
    ) {
        self.threads.insert(thread_id.clone(), thread);
        self.layout.selected_thread_id = Some(thread_id.clone());
        if let Some(shell_thread) = self.shell.find_thread(&thread_id) {
            self.layout.selected_project_id = Some(shell_thread.project_id.clone());
        }
        self.sync_chat(cx);
        cx.notify();
    }

    #[cfg(test)]
    #[must_use]
    pub(crate) fn chat_for_test(&self) -> Entity<crate::chat::ChatView> {
        self.chat.clone()
    }

    /// Keeps drafts in `path` for this test, as a run with a config directory does.
    #[cfg(test)]
    pub(crate) fn set_drafts_path_for_test(&mut self, path: std::path::PathBuf) {
        self.drafts_path = Some(path);
    }

    #[cfg(test)]
    pub(crate) fn settle_drafts_for_test(&mut self, cx: &mut Context<'_, Self>) {
        self.settle_drafts(cx);
    }

    /// Reads the drafts file back in, as a start does.
    #[cfg(test)]
    pub(crate) fn restore_saved_drafts_for_test(&mut self, cx: &mut Context<'_, Self>) {
        self.restore_saved_drafts(cx);
        cx.notify();
    }

    /// The widths kept for the next launch: the thread sidebar's and the right panel's.
    #[cfg(test)]
    pub(crate) fn saved_panel_widths_for_test(&self) -> (Option<f32>, Option<f32>) {
        self.sidebar.saved_widths()
    }

    /// The right panel's width as drawn in a window `viewport_w` wide.
    #[cfg(test)]
    pub(crate) fn right_panel_effective_width_for_test(&self, viewport_w: f32) -> f32 {
        self.right_panel_effective_width(viewport_w)
    }

    #[cfg(test)]
    pub(crate) fn dismiss_shell_popovers_for_test(&mut self, cx: &mut Context<'_, Self>) {
        self.dismiss_shell_popovers(cx);
    }

    /// The open new-thread draft's id and project.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn open_draft_for_test(&self) -> Option<(String, String)> {
        self.draft
            .as_ref()
            .map(|d| (d.draft_id.clone(), d.project_id.clone()))
    }

    #[cfg(test)]
    #[must_use]
    pub(crate) fn thread_menu_copy_open_for_test(&self) -> bool {
        self.thread_menu.as_ref().is_some_and(|m| m.copy_open)
    }

    #[cfg(test)]
    #[must_use]
    pub(crate) fn thread_menu_open_for_test(&self) -> bool {
        self.thread_menu.is_some()
    }

    #[cfg(test)]
    #[must_use]
    pub(crate) fn theme_id_for_test(&self) -> &str {
        &self.theme_id
    }

    /// Scopes the thread sidebar to one workspace (`Some(project_id)`) or all
    /// projects (`None`).
    pub(crate) fn select_workspace(
        &mut self,
        workspace_id: Option<String>,
        cx: &mut Context<'_, Self>,
    ) {
        self.active_workspace = workspace_id;
        rail_workspaces::save_active_workspace(self.active_workspace.as_deref());
        // A selection made under one scope can hold threads the next scope hides.
        self.thread_selection.clear();
        self.sidebar_filter_menu_open = false;
        // The shelf pages for the projects now in scope.
        self.drive_older_pages(cx);
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

    /// Mirrors `Tooltip disabled={isRenaming || ...}`: no hover card while a thread menu is
    /// open or a title is being renamed.
    #[must_use]
    pub(crate) fn thread_hover_suppressed(&self) -> bool {
        self.thread_menu.is_some() || self.renaming_thread_id.is_some() || self.pointer_captured()
    }

    #[cfg(test)]
    pub(crate) fn open_thread_hover_for_test(
        &mut self,
        thread_id: &str,
        cx: &mut Context<'_, Self>,
    ) {
        let now = std::time::Instant::now();
        if let crate::sidebar::hover_card_state::Entered::Wait(generation) =
            self.thread_hover.enter(thread_id, now)
        {
            self.thread_hover.elapse(generation);
        }
        cx.notify();
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
        self.settle_thread_along(thread_id, settled, &HashSet::new(), cx);
    }

    /// [`Self::settle_thread`] for a thread settled together with others (`settleThreads`): the
    /// open thread moves on to one that is not being settled with it.
    fn settle_thread_along(
        &mut self,
        thread_id: String,
        settled: bool,
        co_settling: &HashSet<String>,
        cx: &mut Context<'_, Self>,
    ) {
        self.settle_thread_reporting(thread_id, settled, co_settling, cx, |_, _, _| {});
    }

    /// [`Self::settle_thread_along`] that says whether the server took the command, for a drop
    /// that holds the settle on screen until it does.
    fn settle_thread_reporting(
        &mut self,
        thread_id: String,
        settled: bool,
        co_settling: &HashSet<String>,
        cx: &mut Context<'_, Self>,
        done: impl FnOnce(&mut Self, bool, &mut Context<'_, Self>) + 'static,
    ) {
        let Some(connection) = self.connection_for_thread(&thread_id) else {
            done(self, false, cx);
            return;
        };
        let Ok(cmd) = crate::commands::settle_thread(&thread_id, settled) else {
            done(self, false, cx);
            return;
        };
        // The undo restores the thread as it is now (`planThreadUndo("settle", thread)`); a
        // settled thread that is un-settled by hand has nothing left to undo.
        let undo_plan = settled.then(|| {
            conn_state::plan_settle_undo(self.shell.find_thread(&thread_id).map(settle_facts))
        });
        if settled {
            // Settling supersedes an older unpin undo, which the server would read as a promotion
            // that un-settles.
            self.forget_thread_undo(&thread_id, &[ThreadUndoKind::Pin]);
        } else {
            self.forget_thread_undo(&thread_id, &[ThreadUndoKind::Settle]);
        }
        // `planForwardNavigation`: settling the open thread moves on, planned before the shell
        // changes under it.
        let forward = (settled
            && self.layout.selected_thread_id.as_deref() == Some(thread_id.as_str())
            && self.draft.is_none())
        .then(|| self.plan_forward_navigation(&thread_id, co_settling));
        cx.spawn(
            async move |this, cx| match connection.dispatch_command(cmd).await {
                Ok(_) => {
                    let _ = this.update(cx, |app, cx| {
                        if let Some(forward) = forward
                            && app.layout.selected_thread_id.as_deref() == Some(thread_id.as_str())
                        {
                            app.go_forward(forward, cx);
                        }
                        // Only a settle the server took shows the notice (`showThreadUndoNotice`).
                        if let Some(plan) = undo_plan {
                            app.offer_thread_undo(thread_id, ThreadUndoKind::Settle, plan, cx);
                        }
                        done(app, true, cx);
                    });
                }
                Err(e) => {
                    eprintln!("settle: dispatchCommand failed: {e}");
                    let _ = this.update(cx, |app, cx| done(app, false, cx));
                }
            },
        )
        .detach();
    }

    /// `planForwardNavigation`: the next active thread after `thread_id` in sidebar order
    /// (wrapping) that is not in `parked`, else a new thread in its project.
    fn plan_forward_navigation(
        &self,
        thread_id: &str,
        parked: &HashSet<String>,
    ) -> ForwardNavigation {
        let ordered = crate::sidebar::thread_list::ordered_active_thread_ids(&self.shell);
        match conn_state::next_after_settle(&ordered, thread_id, |id| parked.contains(id)) {
            Some(next) => ForwardNavigation::Thread(next.to_owned()),
            None => ForwardNavigation::NewThread(
                self.shell
                    .find_thread(thread_id)
                    .map(|t| t.project_id.clone()),
            ),
        }
    }

    fn go_forward(&mut self, forward: ForwardNavigation, cx: &mut Context<'_, Self>) {
        match forward {
            ForwardNavigation::Thread(next) => self.select_thread(next, cx),
            ForwardNavigation::NewThread(project_id) => {
                self.start_new_thread(project_id, None, cx);
            }
        }
    }

    /// Dispatches one orchestration command, logging failures under `what`.
    fn dispatch_thread_command(
        &self,
        what: &'static str,
        cmd: Result<conn_contract::OrchestrationV2Command, serde_json::Error>,
        cx: &mut Context<'_, Self>,
    ) {
        self.dispatch_thread_command_then(what, cmd, cx, |_, _| {});
    }

    /// Like [`Self::dispatch_thread_command`], and runs `done` once the server took the command.
    fn dispatch_thread_command_then(
        &self,
        what: &'static str,
        cmd: Result<conn_contract::OrchestrationV2Command, serde_json::Error>,
        cx: &mut Context<'_, Self>,
        done: impl FnOnce(&mut Self, &mut Context<'_, Self>) + 'static,
    ) {
        let cmd = match cmd {
            Ok(cmd) => cmd,
            Err(e) => {
                eprintln!("{what}: could not build command: {e}");
                return;
            }
        };
        let Some(connection) = self.connection_for_command(&cmd) else {
            return;
        };
        cx.spawn(
            async move |this, cx| match connection.dispatch_command(cmd).await {
                Ok(_) => {
                    let _ = this.update(cx, done);
                }
                Err(e) => eprintln!("{what}: dispatchCommand failed: {e}"),
            },
        )
        .detach();
    }

    /// `thread.pin` / `thread.unpin`.
    pub(crate) fn pin_thread(
        &mut self,
        thread_id: String,
        pinned: bool,
        cx: &mut Context<'_, Self>,
    ) {
        if pinned {
            // Pinning un-settles, so an older unpin or settle undo would fight this pin
            // (`sendPin` invalidates them).
            self.forget_thread_undo(&thread_id, &[ThreadUndoKind::Pin, ThreadUndoKind::Settle]);
            self.dispatch_thread_command("pin", crate::commands::pin_thread(&thread_id, true), cx);
            return;
        }
        // The undo pins the thread again in the place it had (`planThreadUndo("unpin", thread)`),
        // and the notice shows once the server took the unpin (`unpinThread`).
        let plan =
            conn_state::plan_unpin_undo(self.shell.find_thread(&thread_id).map(settle_facts));
        let undo_id = thread_id.clone();
        self.dispatch_thread_command_then(
            "unpin",
            crate::commands::pin_thread(&thread_id, false),
            cx,
            move |app, cx| app.offer_thread_undo(undo_id, ThreadUndoKind::Pin, plan, cx),
        );
    }

    /// Opens the Thread Actions menu for `thread_id` at `position` (window coordinates).
    pub(crate) fn open_thread_menu(
        &mut self,
        thread_id: String,
        position: gpui_kit::Point<gpui_kit::Pixels>,
        cx: &mut Context<'_, Self>,
    ) {
        self.open_thread_menu_as(thread_id, false, position, cx);
    }

    /// Opens the menu of a sidebar row: on a picked row it acts on every picked thread
    /// (`handleThreadContextMenu`).
    pub(crate) fn open_row_menu(
        &mut self,
        thread_id: String,
        position: gpui_kit::Point<gpui_kit::Pixels>,
        cx: &mut Context<'_, Self>,
    ) {
        let bulk = self.thread_selection.contains(&thread_id);
        self.open_thread_menu_as(thread_id, bulk, position, cx);
    }

    fn open_thread_menu_as(
        &mut self,
        thread_id: String,
        bulk: bool,
        position: gpui_kit::Point<gpui_kit::Pixels>,
        cx: &mut Context<'_, Self>,
    ) {
        self.thread_details.copy_menu = None;
        self.thread_hover.dismiss();
        self.thread_menu_copy_close_gen = self.thread_menu_copy_close_gen.wrapping_add(1);
        self.thread_menu_focus_pending = true;
        self.thread_menu = Some(ThreadMenuAnchor {
            thread_id,
            draft: false,
            bulk,
            position,
            copy_open: false,
            cursor: MenuCursor::default(),
        });
        cx.notify();
    }

    /// Opens the header title's menu after the `500ms` double-click window, unless a
    /// double-click (rename) arrives first.
    pub(crate) fn schedule_header_title_menu(
        &mut self,
        thread_id: String,
        position: gpui_kit::Point<gpui_kit::Pixels>,
        cx: &mut Context<'_, Self>,
    ) {
        self.header_menu_generation = self.header_menu_generation.wrapping_add(1);
        let generation = self.header_menu_generation;
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(500))
                .await;
            let _ = this.update(cx, |app, cx| {
                if app.header_menu_generation == generation && app.renaming_thread_id.is_none() {
                    app.open_thread_menu(thread_id, position, cx);
                }
            });
        })
        .detach();
    }

    /// Immediately opens the Thread Actions `Copy` submenu and cancels any pending close.
    pub(crate) fn open_thread_menu_copy_submenu(&mut self, cx: &mut Context<'_, Self>) {
        self.thread_menu_copy_close_gen = self.thread_menu_copy_close_gen.wrapping_add(1);
        if let Some(menu) = &mut self.thread_menu
            && !menu.copy_open
        {
            menu.copy_open = true;
            cx.notify();
        }
    }

    /// Keeps the `Copy` submenu open when the pointer enters the submenu or its hover bridge.
    pub(crate) fn keep_thread_menu_copy_open(&mut self, cx: &mut Context<'_, Self>) {
        self.open_thread_menu_copy_submenu(cx);
    }

    /// Closes the `Copy` submenu after a short grace delay unless the pointer enters it.
    pub(crate) fn schedule_thread_menu_copy_close(&mut self, cx: &mut Context<'_, Self>) {
        if !self.thread_menu.as_ref().is_some_and(|m| m.copy_open) {
            return;
        }
        self.thread_menu_copy_close_gen = self.thread_menu_copy_close_gen.wrapping_add(1);
        let generation = self.thread_menu_copy_close_gen;
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(crate::sidebar::thread_menu::SUBMENU_CLOSE_DELAY)
                .await;
            let _ = this.update(cx, |app, cx| {
                if app.thread_menu_copy_close_gen == generation
                    && let Some(menu) = &mut app.thread_menu
                    && menu.copy_open
                {
                    menu.copy_open = false;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    /// Closes open shell popovers (Thread Actions menu, details card and its menus).
    /// Returns whether anything closed.
    fn dismiss_shell_popovers(&mut self, cx: &mut Context<'_, Self>) -> bool {
        let mut changed = self.thread_menu.take().is_some();
        changed |= self.rail_menu.take().is_some();
        if changed {
            self.thread_menu_copy_close_gen = self.thread_menu_copy_close_gen.wrapping_add(1);
        }
        let details = &mut self.thread_details;
        if details.copy_menu.take().is_some() {
            changed = true;
        } else if details.open_in_menu_open || details.scripts_menu_open {
            details.open_in_menu_open = false;
            details.scripts_menu_open = false;
            changed = true;
        } else if details.open {
            details.open = false;
            changed = true;
        }
        if changed {
            cx.notify();
        }
        changed
    }

    /// Writes `text` to the system clipboard.
    pub(crate) fn copy_to_clipboard(&mut self, text: String, cx: &mut Context<'_, Self>) {
        cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(text));
    }

    /// Runs one Thread Actions menu item (`handleThreadContextMenu` switch).
    pub(crate) fn run_thread_menu_action(
        &mut self,
        thread_id: String,
        action: ThreadMenuAction,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let bulk = self.thread_menu.as_ref().is_some_and(|menu| menu.bulk);
        self.thread_menu = None;
        cx.notify();
        if bulk {
            self.run_bulk_action(action, window, cx);
            return;
        }
        let Some(thread) = self.shell.find_thread(&thread_id).cloned() else {
            return;
        };
        match action {
            ThreadMenuAction::Pin => self.pin_thread(thread_id, true, cx),
            ThreadMenuAction::Unpin => self.pin_thread(thread_id, false, cx),
            ThreadMenuAction::Settle => self.settle_thread(thread_id, true, cx),
            ThreadMenuAction::Unsettle => self.settle_thread(thread_id, false, cx),
            ThreadMenuAction::Rename => {
                self.start_thread_rename(thread_id, thread.title, window, cx);
            }
            ThreadMenuAction::RegenerateTitle => {
                if thread
                    .title_regeneration
                    .as_ref()
                    .is_some_and(Option::is_some)
                {
                    return;
                }
                self.dispatch_thread_command(
                    "regenerate title",
                    crate::commands::regenerate_thread_title(&thread_id),
                    cx,
                );
            }
            ThreadMenuAction::MarkUnread => self.dispatch_thread_command(
                "mark unread",
                crate::commands::mark_thread_unread(&thread_id),
                cx,
            ),
            ThreadMenuAction::FilterByProject => {
                let next = (self.active_workspace.as_deref() != Some(thread.project_id.as_str()))
                    .then(|| thread.project_id.clone());
                self.select_workspace(next, cx);
            }
            ThreadMenuAction::Copy => {}
            ThreadMenuAction::CopyPath => {
                if let Some(path) = thread_cwd(&self.shell, &thread) {
                    self.copy_to_clipboard(path, cx);
                }
            }
            ThreadMenuAction::CopyBranch => {
                if let Some(branch) = thread.branch.filter(|b| !b.is_empty()) {
                    self.copy_to_clipboard(branch, cx);
                }
            }
            ThreadMenuAction::CopyThread => self.copy_to_clipboard(thread.title, cx),
            ThreadMenuAction::CopyThreadId => self.copy_to_clipboard(thread.id, cx),
            ThreadMenuAction::ProjectSettings => {
                if self.settings_modal.is_none() {
                    self.open_settings(window, cx);
                }
            }
            ThreadMenuAction::Delete => {
                self.confirm_delete_thread(thread_id, thread.title, window, cx)
            }
            // Only a draft row's menu offers it; `run_draft_menu_action` handles that.
            ThreadMenuAction::DiscardDraft => {}
        }
    }

    /// `Delete thread "<title>"?` destructive confirmation, then `thread.delete`.
    fn confirm_delete_thread(
        &mut self,
        thread_id: String,
        title: String,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let answer = window.prompt(
            gpui_kit::PromptLevel::Critical,
            &format!("Delete thread \"{title}\"?"),
            Some("This permanently clears conversation history for this thread."),
            &["Delete", "Cancel"],
            cx,
        );
        cx.spawn(async move |this, cx| {
            if answer.await != Ok(0) {
                return;
            }
            let _ = this.update(cx, |app, cx| {
                app.delete_thread_now(&thread_id, &HashSet::new(), cx);
            });
        })
        .detach();
    }

    /// `Delete N threads?` for the threads picked for a bulk action, then `thread.delete` for
    /// each (`handleMultiSelectContextMenu` `delete`).
    fn confirm_delete_threads(
        &mut self,
        thread_ids: Vec<String>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let count = thread_ids.len();
        let answer = window.prompt(
            gpui_kit::PromptLevel::Critical,
            &format!(
                "Delete {count} {}?",
                if count == 1 { "thread" } else { "threads" }
            ),
            Some("This permanently clears conversation history for these threads."),
            &["Delete", "Cancel"],
            cx,
        );
        cx.spawn(async move |this, cx| {
            if answer.await != Ok(0) {
                return;
            }
            let _ = this.update(cx, |app, cx| {
                let deleting: HashSet<String> = thread_ids.iter().cloned().collect();
                for thread_id in &thread_ids {
                    app.delete_thread_now(thread_id, &deleting, cx);
                }
                app.thread_selection.remove(&thread_ids);
                cx.notify();
            });
        })
        .detach();
    }

    /// Sends `thread.delete`. The open thread moves on to one that is not deleted with it, the
    /// undos that restore its place end, and its unsent input goes with it.
    fn delete_thread_now(
        &mut self,
        thread_id: &str,
        deleting: &HashSet<String>,
        cx: &mut Context<'_, Self>,
    ) {
        if self.layout.selected_thread_id.as_deref() == Some(thread_id) {
            let forward = self.plan_forward_navigation(thread_id, deleting);
            self.go_forward(forward, cx);
        }
        // Deleting ends every undo that restores the thread's place (`expireThreadUndos`).
        self.forget_thread_undo(thread_id, &[ThreadUndoKind::Settle, ThreadUndoKind::Pin]);
        // The thread's unsent input goes with it (`clearComposerDraftForThread`).
        let deleted = thread_id.to_owned();
        // Before the thread leaves the shell, which tells its environment.
        let owner = self.panel_owner_of_thread(thread_id);
        self.dispatch_thread_command_then(
            "delete thread",
            crate::commands::delete_thread(thread_id),
            cx,
            move |app, cx| {
                app.forget_thread_draft(&deleted, cx);
                app.release_thread_panel(&owner, cx);
            },
        );
    }

    /// Ticks the sidebar each second while a visible row shows a live elapsed label, else each
    /// minute for relative ages (`useNowSecond` / `useNowMinute`).
    fn start_sidebar_clock(&mut self, cx: &mut Context<'_, Self>) {
        let task = cx.spawn(async move |this, cx| {
            let mut last_minute = 0_i64;
            loop {
                cx.background_executor()
                    .timer(std::time::Duration::from_secs(1))
                    .await;
                let alive = this.update(cx, |app, cx| {
                    let now = crate::sidebar::thread_list::current_unix_secs();
                    let live = app.layout.sidebar_open
                        && app.shell.top_level_active_threads().any(|t| {
                            crate::sidebar::thread_list::resolve_row_status(t).is_some_and(|s| {
                                matches!(
                                    s,
                                    crate::sidebar::thread_list::RowStatus::Working
                                        | crate::sidebar::thread_list::RowStatus::Goal
                                        | crate::sidebar::thread_list::RowStatus::Waiting
                                )
                            })
                        });
                    if app.drafts_path.is_some() {
                        // The open draft's text changes without telling the app.
                        app.settle_drafts(cx);
                    }
                    let minute = now / 60;
                    if minute != last_minute {
                        app.expire_offline(cx);
                    }
                    if live || app.thread_details.open || minute != last_minute {
                        last_minute = minute;
                        cx.notify();
                    }
                });
                if alive.is_err() {
                    break;
                }
            }
        });
        self._sidebar_clock = Some(task);
    }

    /// Applies one pointer move of a seam drag: the width follows the pointer between its
    /// minimum and what the window leaves (`LayoutState::drag_sidebar_width`).
    fn apply_seam_drag(&mut self, drag: SeamDrag, x: f32, y: f32, viewport: (f32, f32)) {
        let (viewport_w, viewport_h) = viewport;
        let rail = crate::shell::WORKSPACE_RAIL_WIDTH_PX;
        match drag {
            SeamDrag::TerminalDrawer { from_y, start } => {
                self.terminal_drawer_height =
                    clamp_terminal_drawer_height(start + (from_y - y), viewport_h);
            }
            SeamDrag::Sidebar { from_x, start } => {
                self.layout
                    .drag_sidebar_width(start + (x - from_x), viewport_w, rail);
            }
            SeamDrag::RightPanel { from_x, start } => {
                self.layout
                    .drag_right_panel_width(start - (x - from_x), viewport_w, rail);
            }
        }
    }

    /// The right panel's width as drawn: the width kept for it, held to what the window and the
    /// sidebar leave (`getPreviewPanelMaxWidth`).
    fn right_panel_effective_width(&self, viewport_w: f32) -> f32 {
        let left = if self.layout.sidebar_open {
            crate::shell::WORKSPACE_RAIL_WIDTH_PX + self.layout.sidebar_width
        } else {
            0.0
        };
        self.layout
            .right_panel_width
            .min(conn_state::right_panel_max_width(viewport_w, left))
            .max(conn_state::RIGHT_PANEL_MIN_WIDTH)
    }

    /// Keeps the width a finished seam drag ended on, when it moved (`finish` in
    /// `useResizableWidth`).
    fn remember_seam_width(&mut self, drag: SeamDrag) {
        let (mut sidebar, mut panel) = self.sidebar.saved_widths();
        match drag {
            SeamDrag::Sidebar { start, .. } if self.layout.sidebar_width != start => {
                sidebar = Some(self.layout.sidebar_width);
            }
            SeamDrag::RightPanel { start, .. } if self.layout.right_panel_width != start => {
                panel = Some(self.layout.right_panel_width);
            }
            _ => return,
        }
        self.sidebar.remember_widths(sidebar, panel);
    }

    /// Toggles the top-right Thread Details card and loads its data when it opens.
    pub(crate) fn toggle_thread_details(
        &mut self,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.thread_details.open = !self.thread_details.open;
        self.thread_details.open_in_menu_open = false;
        self.thread_details.scripts_menu_open = false;
        self.thread_details.copy_menu = None;
        if self.thread_details.open {
            window.focus(&self.focus_handle, cx);
            self.refresh_thread_details(cx);
        }
        cx.notify();
    }

    /// Loads VCS status (`vcs.refreshStatus`) and scheduled tasks for the open thread.
    fn refresh_thread_details(&mut self, cx: &mut Context<'_, Self>) {
        let Some(thread) = self
            .layout
            .selected_thread_id
            .as_deref()
            .and_then(|id| self.shell.find_thread(id))
        else {
            return;
        };
        let thread_id = thread.id.clone();
        let cwd = thread_cwd(&self.shell, thread);
        if self.thread_details.loaded_for.as_deref() != Some(thread_id.as_str()) {
            self.thread_details.vcs = None;
            self.thread_details.prs_expanded = false;
            self.thread_details.previous_agents_expanded = false;
        }
        self.thread_details.loaded_for = Some(thread_id.clone());
        let Some(connection) = self.context_connection() else {
            return;
        };
        if let Some(cwd) = cwd {
            self.thread_details.vcs_loading = true;
            let conn = connection.clone();
            cx.spawn(async move |this, cx| {
                let payload = conn_contract::VcsRefreshStatusPayload {
                    cwd,
                    local_only: Some(true),
                };
                let result = conn
                    .call::<_, conn_contract::VcsStatusResult>("vcs.refreshStatus", &payload)
                    .await;
                let _ = this.update(cx, |app, cx| {
                    if app.thread_details.loaded_for.as_deref() != Some(thread_id.as_str()) {
                        return;
                    }
                    app.thread_details.vcs_loading = false;
                    match result {
                        Ok(status) => app.thread_details.vcs = Some(status),
                        Err(e) => eprintln!("thread details: vcs.refreshStatus failed: {e}"),
                    }
                    cx.notify();
                });
            })
            .detach();
        }
        // First `scheduledTasks.subscribe` snapshot, then stop the stream.
        let (stream_id, mut rx) =
            connection.stream_json("scheduledTasks.subscribe", serde_json::json!({}));
        cx.spawn(async move |this, cx| {
            let first = rx.recv().await;
            connection.cancel_stream(stream_id);
            let _ = this.update(cx, |app, cx| {
                match first.map(serde_json::from_value::<conn_state::ScheduledTaskListResult>) {
                    Some(Ok(list)) => {
                        app.thread_details.tasks = list.tasks.into_iter().flatten().collect();
                        app.thread_details.tasks_error = None;
                    }
                    Some(Err(e)) => {
                        app.thread_details.tasks_error =
                            Some(format!("Failed to load scheduled tasks: {e}"));
                    }
                    None => {}
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(crate) fn open_details_copy_menu(
        &mut self,
        target: DetailsCopyTarget,
        position: gpui_kit::Point<gpui_kit::Pixels>,
        cx: &mut Context<'_, Self>,
    ) {
        self.thread_details.copy_menu = Some((target, position));
        cx.notify();
    }

    pub(crate) fn close_details_copy_menu(&mut self, cx: &mut Context<'_, Self>) {
        if self.thread_details.copy_menu.take().is_some() {
            cx.notify();
        }
    }

    pub(crate) fn toggle_details_open_in_menu(&mut self, cx: &mut Context<'_, Self>) {
        self.thread_details.open_in_menu_open = !self.thread_details.open_in_menu_open;
        self.thread_details.scripts_menu_open = false;
        cx.notify();
    }

    pub(crate) fn toggle_details_scripts_menu(&mut self, cx: &mut Context<'_, Self>) {
        self.thread_details.scripts_menu_open = !self.thread_details.scripts_menu_open;
        self.thread_details.open_in_menu_open = false;
        cx.notify();
    }

    pub(crate) fn toggle_details_prs(&mut self, cx: &mut Context<'_, Self>) {
        self.thread_details.prs_expanded = !self.thread_details.prs_expanded;
        cx.notify();
    }

    pub(crate) fn toggle_details_previous_agents(&mut self, cx: &mut Context<'_, Self>) {
        self.thread_details.previous_agents_expanded =
            !self.thread_details.previous_agents_expanded;
        cx.notify();
    }

    /// Picks the `Open in` editor (Conn persists the preferred editor).
    pub(crate) fn set_preferred_editor(
        &mut self,
        editor: EditorTarget,
        cx: &mut Context<'_, Self>,
    ) {
        self.thread_details.preferred_editor = Some(editor);
        self.thread_details.open_in_menu_open = false;
        self.chat
            .update(cx, |chat, _| chat.set_preferred_editor(Some(editor)));
        cx.notify();
    }

    /// Opens the thread's workspace in `editor` (`open -a <App> <path>`, or Finder).
    pub(crate) fn open_thread_in_editor(
        &mut self,
        editor: EditorTarget,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(path) = self
            .layout
            .selected_thread_id
            .as_deref()
            .and_then(|id| self.shell.find_thread(id))
            .and_then(|t| thread_cwd(&self.shell, t))
        else {
            return;
        };
        let mut command = std::process::Command::new("open");
        if let Some(app) = editor.app_name() {
            command.arg("-a").arg(app);
        }
        if let Err(e) = command.arg(&path).spawn() {
            eprintln!("open in {}: {e}", editor.label());
        }
        cx.notify();
    }

    /// `vcs.init` for a non-git workspace (`Initialize Git`).
    pub(crate) fn init_git_for_thread(&mut self, cx: &mut Context<'_, Self>) {
        let Some(cwd) = self
            .layout
            .selected_thread_id
            .as_deref()
            .and_then(|id| self.shell.find_thread(id))
            .and_then(|t| thread_cwd(&self.shell, t))
        else {
            return;
        };
        let Some(connection) = self.context_connection() else {
            return;
        };
        self.thread_details.git_init_pending = true;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let payload = conn_contract::VcsInitInput { cwd, kind: None };
            let result = connection
                .call::<_, serde_json::Value>("vcs.init", &payload)
                .await;
            let _ = this.update(cx, |app, cx| {
                app.thread_details.git_init_pending = false;
                if let Err(e) = result {
                    eprintln!("thread details: vcs.init failed: {e}");
                }
                app.refresh_thread_details(cx);
                cx.notify();
            });
        })
        .detach();
    }

    /// `scheduledTasks.runNow` from the Automations section.
    pub(crate) fn run_scheduled_task_now(&mut self, task_id: String, cx: &mut Context<'_, Self>) {
        self.scheduled_task_call(
            task_id.clone(),
            "scheduledTasks.runNow",
            serde_json::json!({ "id": task_id }),
            cx,
        );
    }

    /// `scheduledTasks.setEnabled` from the Automations section switch.
    pub(crate) fn set_scheduled_task_enabled(
        &mut self,
        task_id: String,
        enabled: bool,
        cx: &mut Context<'_, Self>,
    ) {
        self.scheduled_task_call(
            task_id.clone(),
            "scheduledTasks.setEnabled",
            serde_json::json!({ "id": task_id, "enabled": enabled }),
            cx,
        );
    }

    fn scheduled_task_call(
        &mut self,
        task_id: String,
        method: &'static str,
        payload: serde_json::Value,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(connection) = self.connection.clone() else {
            return;
        };
        self.thread_details.busy_task_id = Some(task_id);
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = connection
                .call::<_, conn_state::ScheduledTaskRunNowResult>(method, &payload)
                .await;
            let _ = this.update(cx, |app, cx| {
                app.thread_details.busy_task_id = None;
                match result {
                    Ok(updated) => {
                        if let Some(slot) = app
                            .thread_details
                            .tasks
                            .iter_mut()
                            .find(|t| t.id == updated.task.id)
                        {
                            *slot = updated.task;
                        }
                        app.thread_details.tasks_error = None;
                    }
                    Err(e) => {
                        app.thread_details.tasks_error =
                            Some(format!("Could not update task: {e}"));
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Starts inline renaming for `thread_id` in the sidebar (double-click, `Rename thread`).
    pub(crate) fn start_thread_rename(
        &mut self,
        thread_id: String,
        current_title: String,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.begin_rename(thread_id, current_title, false, window, cx);
    }

    /// Starts inline renaming of the chat header title (double-click on the title).
    pub(crate) fn start_header_rename(
        &mut self,
        thread_id: String,
        current_title: String,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        // A double-click cancels the pending single-click menu open.
        self.header_menu_generation = self.header_menu_generation.wrapping_add(1);
        self.thread_menu = None;
        self.begin_rename(thread_id, current_title, true, window, cx);
    }

    fn begin_rename(
        &mut self,
        thread_id: String,
        current_title: String,
        in_header: bool,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.thread_hover.dismiss();
        self.renaming_thread_id = Some(thread_id);
        self.rename_in_header = in_header;
        self.rename_input.update(cx, |input, cx| {
            input.set_value(current_title, window, cx);
            input.focus(window, cx);
        });
        // Select the whole title on focus, as Conn's rename inputs do.
        window.defer(cx, |window, cx| {
            window.dispatch_action(Box::new(gpui_kit::component::input::SelectAll), cx);
        });
        cx.notify();
    }

    /// Commits the active inline thread rename via `thread.metadata.update`.
    pub(crate) fn commit_thread_rename(&mut self, cx: &mut Context<'_, Self>) {
        let Some(thread_id) = self.renaming_thread_id.take() else {
            return;
        };
        self.rename_in_header = false;
        let next_title = self.rename_input.read(cx).value().trim().to_owned();
        let unchanged = self
            .shell
            .find_thread(&thread_id)
            .is_some_and(|t| t.title == next_title);
        if next_title.is_empty() || unchanged {
            cx.notify();
            return;
        }
        let Some(connection) = self.connection_for_thread(&thread_id) else {
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
        self.rename_in_header = false;
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

    /// Current layout state.
    #[cfg_attr(
        all(not(feature = "automation"), not(test)),
        expect(dead_code, reason = "read by the automation hook and UI tests")
    )]
    #[must_use]
    pub(crate) fn layout(&self) -> &LayoutState {
        &self.layout
    }

    /// Current shell state.
    #[cfg_attr(
        not(any(feature = "automation", test)),
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

    fn render_chat_column(&self, viewport_h: f32, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let header = render_chat_header(
            &ChatHeaderProps {
                shell: &self.shell,
                layout: &self.layout,
                draft_project_id: self.draft.as_ref().map(|d| d.project_id.as_str()),
                details_open: self.thread_details.open,
                terminal_open: self.terminal_drawer_open,
                header_rename: (self.rename_in_header && self.renaming_thread_id.is_some())
                    .then_some(&self.rename_input),
                tokens: &self.tokens,
                geometry: &self.geometry,
            },
            cx,
        );

        let join = CardJoin {
            left: self.layout.sidebar_open,
            right: self.layout.right_panel_open,
        };

        // Matches real Conn (`ChatView.tsx`): the chat card re-roots `--background` to opaque
        // `--shell-card` (`bg-background`), keeping the chat surface deeper than the glossy outer
        // shell and slightly deeper than the translucent sidebar card.
        let chat_card =
            inset_card(&self.tokens, &self.geometry, join).bg(hsla(self.tokens.shell_card));
        // Conn hosts the terminal as a bottom sheet in the chat card (`ThreadTerminalDrawer`).
        // The right panel's Terminal tab shows the same view, so the drawer yields to it.
        let drawer_visible = self.terminal_drawer_open
            && !(self.layout.right_panel_open
                && self.layout.right_panel_tab == RightPanelTab::Terminal);
        let chat_card = if drawer_visible {
            let terminal = self.right_panel.read(cx).terminal_entity();
            // A thread shown again with its drawer open starts the shell here, as the tab does.
            terminal.update(cx, |terminal, cx| terminal.ensure_started(cx));
            chat_card
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_h_0()
                        .min_w_0()
                        .child(self.chat.clone()),
                )
                .child(crate::panels::terminal_drawer::render_terminal_drawer(
                    &terminal,
                    clamp_terminal_drawer_height(self.terminal_drawer_height, viewport_h),
                    &self.tokens,
                    cx,
                ))
        } else {
            chat_card.child(self.chat.clone())
        };

        let mut column = div()
            .id("conn-chat-column")
            .a11y(gpui_kit::Role::Main, "shell.chat-column", "Conversation")
            .relative()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .h_full()
            .child(header)
            .child(chat_card);

        // `ThreadDetailsCard` popover: `side="bottom" align="end"` under the `SquareMenu`
        // toggle, `max-h-[calc(100dvh-6.5rem)]`.
        if self.thread_details.open
            && self.draft.is_none()
            && let Some(thread) = self
                .layout
                .selected_thread_id
                .as_deref()
                .and_then(|id| self.shell.find_thread(id))
        {
            let environment_label = self
                .hover_environment_label(self.layout.selected_thread_id.as_deref())
                .unwrap_or_else(|| "Local".to_owned());
            let card = render_thread_details_card(
                &DetailsCardProps {
                    shell: &self.shell,
                    thread,
                    state: &self.thread_details,
                    environment_label: &environment_label,
                    max_height: (viewport_h
                        - self.geometry.header_height_px
                        - self.geometry.shell_inset_px
                        - 2.0 * THREAD_DETAILS_CARD_GAP_PX)
                        .max(160.0),
                    tokens: &self.tokens,
                },
                cx,
            );
            // Sits inside the chat card with Conn's `THREAD_DETAILS_CARD_GAP` (12px) from its
            // top and right edges (`threadDetailsCardLayout.ts`); the card has no right margin
            // when the right panel is joined to it.
            let card_right_margin = if self.layout.right_panel_open {
                0.0
            } else {
                self.geometry.shell_inset_px
            };
            column = column.child(
                gpui_kit::deferred(
                    div()
                        .absolute()
                        .top(px(
                            self.geometry.header_height_px + THREAD_DETAILS_CARD_GAP_PX
                        ))
                        .right(px(card_right_margin + THREAD_DETAILS_CARD_GAP_PX))
                        .child(card),
                )
                .with_priority(4),
            );
        }
        column
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

    /// A `1`-`9` key with no control focused picks the pending question's option, as a key
    /// pressed on a page's body does in Conn. The chat must be showing.
    fn pick_question_option_from_idle_focus(
        &mut self,
        event: &gpui_kit::KeyDownEvent,
        window: &mut gpui_kit::Window,
        cx: &mut Context<'_, Self>,
    ) -> bool {
        let chat_hidden = self.layout.right_panel_open && self.right_panel_maximized;
        // A sidebar row focused by the pointer is as idle as the page body; one focused by keys
        // keeps its keys (`[data-sidebar-row]:focus-visible`).
        let idle = window.focused(cx).is_none_or(|focused| {
            focused == self.focus_handle
                || (!window.last_input_was_keyboard() && self.sidebar_tree.owns(&focused))
        });
        if chat_hidden || !idle {
            return false;
        }
        self.chat
            .update(cx, |chat, cx| chat.on_question_key(event, window, cx, true))
    }

    /// Handles a surface's letter while the launcher shows and nothing has the keyboard, as
    /// Conn's launcher does. Returns whether the key was used.
    fn handle_launcher_key(
        &mut self,
        event: &gpui_kit::KeyDownEvent,
        window: &mut gpui_kit::Window,
        cx: &mut Context<'_, Self>,
    ) -> bool {
        if !self.right_panel_shows_launcher() {
            return false;
        }
        let modifiers = event.keystroke.modifiers;
        if modifiers.control || modifiers.platform || modifiers.alt || modifiers.shift {
            return false;
        }
        if window
            .focused(cx)
            .is_some_and(|focused| focused != self.focus_handle)
        {
            return false;
        }
        match RightPanelTab::from_menu_shortcut(&event.keystroke.key) {
            Some(tab) if self.available_right_panel_tabs().contains(&tab) => {
                self.add_right_panel_tab(tab, cx);
                true
            }
            _ => false,
        }
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
            self.add_right_panel_tab(tab, cx);
            return true;
        }
        false
    }

    fn render_right_panel_column(
        &self,
        viewport_w: f32,
        cx: &mut Context<'_, Self>,
    ) -> impl IntoElement {
        use crate::panels::header::{PanelHeaderCallbacks, PanelHeaderProps, render_panel_header};
        use std::rc::Rc;
        let app = cx.entity();
        let available_tabs = self.available_right_panel_tabs();
        let active_surface = self.right_panel.read(cx).displayed_surface(
            self.right_panel_surface(),
            self.right_panel_tabs.tabs(),
            cx,
        );
        let browser_titles = self
            .right_panel
            .read(cx)
            .browser_titles(self.right_panel_tabs.browser_ids(), cx);
        let header = render_panel_header(
            PanelHeaderProps {
                open_tabs: self.right_panel_tabs.tabs(),
                browser_titles: &browser_titles,
                active_tab: &active_surface,
                maximized: self.right_panel_maximized,
                owns_window_leading_edge: self.right_panel_maximized && !self.layout.sidebar_open,
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
                        app.update(cx, |this, cx| this.add_right_panel_tab(tab, cx));
                    })
                },
                on_toggle_maximize: {
                    let app = app.clone();
                    Rc::new(move |_, cx| {
                        app.update(cx, |this, cx| this.toggle_right_panel_maximized(cx));
                    })
                },
                on_toggle_panel: {
                    let app = app.clone();
                    Rc::new(move |_, cx| {
                        app.update(cx, |this, cx| {
                            this.right_panel_add_menu_open = false;
                            this.toggle_right_panel(cx);
                        });
                    })
                },
                on_open_sidebar: Rc::new(move |_, cx| {
                    app.update(cx, |this, cx| this.toggle_sidebar(cx));
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
        .bg(hsla(self.tokens.shell_card));
        let card = if self.right_panel_shows_launcher() {
            card.child(crate::panels::header::render_panel_launcher(
                &self.tokens,
                &available_tabs,
                Rc::new({
                    let app = cx.entity();
                    move |tab, _, cx| {
                        app.update(cx, |this, cx| this.add_right_panel_tab(tab, cx));
                    }
                }),
            ))
        } else {
            card.child(self.right_panel.clone())
        };

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
            column
                .w(px(self.right_panel_effective_width(viewport_w)))
                .flex_shrink_0()
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

    /// Switches to a theme locally without pushing to Orbit (used by automation captures).
    #[cfg(feature = "automation")]
    pub(crate) fn set_theme_local(&mut self, theme_id: &str, cx: &mut Context<'_, Self>) -> bool {
        self.apply_theme_choice(theme_id, false, cx)
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
    ///
    /// `origin` is the connection the request came from. It reaches only the panel whose owner
    /// is that environment's `request.thread_id`, resolved when the request is handled: a
    /// thread id another environment also holds is a different thread.
    pub(super) fn dispatch_agent_panel_request(
        &self,
        request: conn_contract::source::DesktopPanelRequest,
        origin: PanelOrigin,
        reply: PanelReply,
        cx: &mut Context<'_, Self>,
    ) {
        const NOT_ON_THREAD: &str = "The user is looking at another thread, so Conn did not run this. Ask them to open your thread, then try again.";

        let device_name = self.device_name();
        cx.spawn(async move |this, cx| {
            let thread = request.panel.thread_id.clone();
            let owner = this
                .read_with(cx, |app, _| app.request_owner(&origin, &thread))
                .map_err(|_| "Conn window closed.".to_owned())
                .and_then(|owner| owner);
            let owner = match owner {
                Ok(owner) => owner,
                Err(error) => {
                    let response = conn_contract::source::DesktopPanelResponse {
                        panel: conn_contract::AgentPanelResponse {
                            request_id: request.panel.request_id,
                            ok: false,
                            device_name: Some(device_name),
                            error: Some(error),
                            database: None,
                            mcp: None,
                            mcp_call: None,
                        },
                        selection: None,
                    };
                    reply.send(response).await;
                    return;
                }
            };
            let response = if let Some(action) = request.files_action {
                Self::handle_files_action(this, request.panel, owner, action, device_name, cx).await
            } else {
                let panel = Self::handle_agent_panel_request(
                    this,
                    request.panel,
                    owner,
                    device_name,
                    NOT_ON_THREAD,
                    cx,
                )
                .await;
                conn_contract::source::DesktopPanelResponse {
                    panel,
                    selection: None,
                }
            };
            reply.send(response).await;
        })
        .detach();
    }

    async fn handle_files_action(
        this: gpui_kit::WeakEntity<Self>,
        request: conn_contract::AgentPanelRequest,
        owner: PanelOwner,
        action: conn_contract::source::FilesAction,
        device: String,
        cx: &mut gpui_kit::AsyncApp,
    ) -> conn_contract::source::DesktopPanelResponse {
        use conn_contract::source::FilesAction;
        let mut selection = None;
        let result = async {
            let valid = |app: &Self| app.thread_panels.owner() == Some(&owner);
            match action {
                FilesAction::Selection => {
                    selection = this
                        .read_with(cx, |app, cx| {
                            if !valid(app) {
                                return Err("The active thread changed.".to_owned());
                            }
                            let selected = app
                                .right_panel_surface_visible()
                                .then(|| app.right_panel.read(cx).selected_source(cx))
                                .flatten();
                            if selected
                                .as_ref()
                                .is_some_and(|source| source.text.len() > 64 * 1024)
                            {
                                return Err("Select a passage smaller than 64 KiB.".to_owned());
                            }
                            Ok(selected)
                        })
                        .map_err(|e| e.to_string())??;
                }
                FilesAction::Reveal {
                    path,
                    lines,
                    excerpt,
                } => {
                    let result = this
                        .update(cx, |app, cx| {
                            if !valid(app) {
                                return Err("The active thread changed.".to_owned());
                            }
                            if !conn_contract::source::workspace_relative(&path) {
                                return Err("Expected a workspace-relative path.".to_owned());
                            }
                            app.select_right_panel_surface(PanelSurface::File(path.clone()), cx);
                            if !app.right_panel_surface_visible() {
                                return Err(
                                    "Close the overlay to reveal source in Files.".to_owned()
                                );
                            }
                            Ok(app.right_panel.update(cx, |panel, cx| {
                                panel.reveal_lines(path, lines, Some(excerpt), cx)
                            }))
                        })
                        .map_err(|e| e.to_string())??;
                    result.await.map_err(|_| {
                        "The file or window changed before Conn could reveal the range.".to_string()
                    })??;
                }
            }
            Ok::<(), String>(())
        }
        .await;
        conn_contract::source::DesktopPanelResponse {
            panel: conn_contract::AgentPanelResponse {
                request_id: request.request_id,
                ok: result.is_ok(),
                device_name: Some(device),
                error: result.err(),
                database: None,
                mcp: None,
                mcp_call: None,
            },
            selection,
        }
    }

    async fn handle_agent_panel_request(
        this: gpui_kit::WeakEntity<Self>,
        request: conn_contract::AgentPanelRequest,
        owner: PanelOwner,
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

        // The shown panel is this environment's thread, not one with the same id elsewhere.
        let on_thread = this
            .read_with(cx, |app, _| app.thread_panels.owner() == Some(&owner))
            .unwrap_or(false);

        if !on_thread {
            if let Ok(Some(error)) = this.update(cx, |app, cx| {
                app.prepare_background_panel(&owner, &request, not_on_thread, cx)
            }) {
                resp.ok = false;
                resp.error = Some(error);
            }
            return resp;
        }

        let target_tab = agent_panel_tab(request.panel);

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
                        if let Ok(Err(refused)) = this.update(cx, |app, cx| {
                            app.right_panel
                                .update(cx, |panel, cx| panel.set_database_sql(&owner, sql, cx))
                        }) {
                            resp.ok = false;
                            resp.error = Some(refused);
                        }
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
                    app.sync_linked_environments(cx);
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
                self.sync_linked_environments(cx);
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

    /// Opens a connection with every app-wide stream: the shell, the server config (the provider
    /// catalog) and panel requests. The launch and a server switch both connect through here.
    fn start_connection(
        config: ServerConfig,
        device_name: String,
    ) -> (Connection, tokio::sync::mpsc::Receiver<ClientEvent>) {
        let (connection, events) = Connection::start(config, crate::live::RT.handle());
        connection.subscribe_shell_with_idle_subagents();
        connection.subscribe_server_config();
        connection.subscribe_panel_requests(Some(device_name));
        (connection, events)
    }

    /// Forgets the old server's shell, threads and selection when the app switches servers.
    /// Right-panel tabs stay: they are not the server's, and the thread may come back.
    fn reset_environment_state(&mut self) {
        self.offline = offline::Offline::new();
        self.primary_confirmed = false;
        self.reset_linked_environments();
        self.shell = ShellState::default();
        self.server_config = std::sync::Arc::default();
        self.threads.clear();
        self.ended_threads.clear();
        self.subscribed_thread_id = None;
        self.reset_child_approvals();
        self.subscribed_annotation_project = None;
        self.files_subscription = None;
        self.annotations.clear();
        self.annotation_last_sent.clear();
        self.layout.selected_thread_id = None;
        self.layout.selected_project_id = None;
        // Drafts belong to their environment; this connection ends any launch in flight.
        self.park_active_draft();
        self.drafts.clear_launching();
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
        self.reset_environment_state();

        let (connection, events) = Self::start_connection(config, self.device_name());
        Self::pump_events(generation, orbit_server_id, events, cx);

        self.connection = Some(connection.clone());
        self.restore_offline_shell();
        let environment_key = self.server_url.clone();
        self.chat.update(cx, |chat, cx| {
            chat.set_error(None, cx);
            chat.set_environment_key(environment_key);
            chat.set_connection(Some(connection.clone()), cx);
        });
        self.push_server_config(cx);
        self.right_panel
            .update(cx, |panel, cx| panel.set_connection(Some(connection), cx));
        self.sync_chat(cx);
        self.sync_linked_environments(cx);
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
            let mut info = self.orbit.settings_info(self.server_url.as_deref());
            info.linked_environments = self.linked_settings_rows();
            info.linked_instance_ids = self.linked_instance_ids();
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

    pub(crate) fn set_persist_composer_context_strip(
        &mut self,
        enabled: bool,
        cx: &mut Context<'_, Self>,
    ) {
        if self.persist_composer_context_strip == enabled {
            return;
        }
        self.persist_composer_context_strip = enabled;
        self.chat
            .update(cx, |chat, cx| chat.set_persist_context_strip(enabled, cx));
        cx.notify();
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
        if let Some(editor) = &self.workspace_editor {
            editor.update(cx, |e, cx| e.set_tokens(tokens.clone(), cx));
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

/// The right-panel tab an agent's `panel_open` request shows.
fn agent_panel_tab(panel: conn_contract::AgentPanelKind) -> RightPanelTab {
    use conn_contract::AgentPanelKind;
    match panel {
        AgentPanelKind::Browser => RightPanelTab::Browser,
        AgentPanelKind::Database => RightPanelTab::Database,
        AgentPanelKind::Mcp => RightPanelTab::Mcp,
        AgentPanelKind::Diff => RightPanelTab::Diff,
        AgentPanelKind::Files => RightPanelTab::Files,
    }
}

impl Render for ConnApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        self.refresh_workspace_images();
        RENDERS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.sync_thread_menu_focus(window, cx);
        self.sync_undo_notice_focus(window, cx);
        #[cfg(feature = "zed-files")]
        if self.layout.right_panel_open
            && self.layout.right_panel_tab == RightPanelTab::File
            && window.focused(cx).is_none()
        {
            self.focus_handle.focus(window, cx);
        }
        let viewport = window.viewport_size();
        let viewport_w = f32::from(viewport.width);
        let viewport_h = f32::from(viewport.height);
        let mut root = div()
            .id("conn-shell-root")
            .a11y_group("shell.root", "Conn workspace")
            .track_focus(&self.focus_handle)
            .capture_key_down(
                cx.listener(|app, event: &gpui_kit::KeyDownEvent, window, cx| {
                    if std::mem::take(&mut app.keystroke_consumed) {
                        return;
                    }
                    if std::env::var_os("CONN_GPUI_FRAME_LOG").is_some() {
                        eprintln!(
                            "key: {:?} {:?}",
                            event.keystroke.modifiers, event.keystroke.key
                        );
                    }
                    if app.thread_traversal_key_down(event, cx) {
                        cx.stop_propagation();
                        return;
                    }
                    if app.handle_add_menu_key(event, cx) {
                        cx.stop_propagation();
                        return;
                    }
                    if app.handle_launcher_key(event, window, cx) {
                        cx.stop_propagation();
                        return;
                    }
                    if app.pick_question_option_from_idle_focus(event, window, cx) {
                        return;
                    }
                    if event.keystroke.key == "escape" && app.escape_shell_popovers(cx) {
                        cx.stop_propagation();
                    }
                }),
            )
            .on_modifiers_changed(cx.listener(
                |app, event: &gpui_kit::ModifiersChangedEvent, window, cx| {
                    #[cfg(feature = "zed-files")]
                    app.right_panel.update(cx, |panel, cx| {
                        panel.file_modifiers_changed(event.modifiers, window, cx)
                    });
                    app.modifiers_changed(&event.modifiers, window, cx);
                },
            ))
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
                    changed |= app.dismiss_shell_popovers(cx);
                    if changed {
                        cx.notify();
                    }
                }),
            )
            .on_mouse_down(
                gpui_kit::MouseButton::Right,
                cx.listener(|app, _, _window, cx| {
                    app.dismiss_shell_popovers(cx);
                }),
            )
            .on_action(cx.listener(|app, _: &ToggleSidebar, _window, cx| {
                app.toggle_sidebar(cx);
            }))
            .on_action(cx.listener(|app, _: &ToggleRightPanel, _window, cx| {
                app.toggle_right_panel(cx);
            }))
            .on_action(cx.listener(|app, _: &ToggleTerminal, window, cx| {
                app.toggle_terminal_drawer(window, cx);
            }))
            .on_action(cx.listener(|app, _: &NewRightPanelSurface, window, cx| {
                app.open_right_panel_add_menu(window, cx);
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

        // What the sidebar draws that changes the app: a drop the server has shown through ends,
        // the search ranks what it found, and the shelf starts its scope.
        self.release_settled_drop();
        let search_text = self.sidebar_search_query(cx);
        if !search_text.trim().is_empty() {
            self.refresh_message_matches(&search_text);
        }
        let shelf_scope = self.settled_scope_key();
        let shelf_visible = self.sidebar.visible_count(&shelf_scope);
        let shelf_more = self.older_more_state();
        // A held row shows the lists as they would be with it dropped where it is.
        let drag_view = self.sidebar.drag.as_ref().map(|drag| {
            let projection = match &drag.target {
                Some(target) => conn_state::sidebar_drag::project(
                    &drag.id,
                    target,
                    &drag.pinned,
                    &drag.active,
                    &drag.settled,
                    // The held row shows in the shelf where it would settle, closed or not.
                    true,
                ),
                None => conn_state::sidebar_drag::Projection {
                    pinned: drag.pinned.clone(),
                    active: drag.active.clone(),
                    settled: drag.settled.clone(),
                },
            };
            (
                drag.id.clone(),
                drag.from,
                drag.target.as_ref().map(|t| t.section),
                projection,
            )
        });
        let draft_rows = self.sidebar_draft_rows(cx);
        let draft_sidebar = DraftSidebar {
            rows: draft_rows
                .iter()
                .map(|row| DraftRowView {
                    row,
                    project: self.shell.project(&row.project_id),
                })
                .collect(),
            undo: self
                .discard_failure
                .map(UndoNotice::Failed)
                .or_else(|| self.discards.notice().map(UndoNotice::Undoable)),
            undo_focus: &self.undo_focus,
            unsent_threads: self.sidebar_unsent_threads(cx),
        };
        if std::mem::take(&mut self.reveal_open_row)
            && let Some(open) = self.layout.selected_thread_id.clone()
        {
            // The row is drawn by the end of this frame, which is when its place is known.
            let app = cx.entity().downgrade();
            window.on_next_frame(move |_, cx| {
                let _ = app.update(cx, |app, cx| {
                    app.sidebar_tree.reveal_row(&open);
                    cx.notify();
                });
            });
        }
        let jump_order = self.jump_hint_order(window, cx);
        let hover_open_for = self
            .thread_hover
            .open_for()
            .filter(|_| !self.thread_hover_suppressed());
        let hover_environment_label = self.hover_environment_label(hover_open_for);
        let machine_icons = self.linked.machine_icons();
        let scratch_projects = self.scratch_project_ids();
        if self.layout.sidebar_open {
            root = root
                .child(render_workspace_rail(
                    &self.orbit.workspaces,
                    &self.workspace_images,
                    self.active_workspace.as_deref(),
                    &self.tokens,
                    &self.geometry,
                    &self.rail_gesture,
                    cx,
                ))
                .child(render_thread_sidebar(
                    &self.shell,
                    &self.layout,
                    &self.orbit.workspaces,
                    self.active_workspace.as_deref(),
                    &draft_sidebar,
                    &SidebarMarks {
                        jump_order: &jump_order,
                        selection: &self.thread_selection,
                        shelf: crate::sidebar::thread_list::ShelfMarks {
                            expanded: self.sidebar.settled_expanded,
                            visible_count: shelf_visible,
                            more: shelf_more,
                        },
                        search: crate::sidebar::thread_list::SearchMarks {
                            order: &self.sidebar.search.order,
                            excerpts: &self.sidebar.search.excerpts,
                            matched_query: &self.sidebar.search.matched_query,
                            pending: self.sidebar.search.pending(),
                            failed: self.sidebar.search.failed(),
                        },
                        pending_drop: self
                            .sidebar
                            .pending_drop
                            .as_ref()
                            .map(|p| (&p.drop, &p.thread)),
                        drag: drag_view.as_ref().map(|(held, from, target, projection)| {
                            crate::sidebar::thread_list::DragMarks {
                                held,
                                from: *from,
                                target: *target,
                                pinned: &projection.pinned,
                                active: &projection.active,
                                settled: &projection.settled,
                            }
                        }),
                        sweep: self.sidebar.sweep.as_ref().map(|sweep| {
                            crate::sidebar::thread_list::SweepMarks {
                                keys: &sweep.keys,
                                action: sweep.action,
                            }
                        }),
                    },
                    &self.sidebar_search_input,
                    self.sidebar_search_highlight.as_deref(),
                    self.renaming_thread_id
                        .as_deref()
                        .filter(|_| !self.rename_in_header),
                    &self.rename_input,
                    self.sidebar_filter_menu_open,
                    &ThreadHoverView {
                        open_for: hover_open_for,
                        environment_label: hover_environment_label.as_deref(),
                        origins: Some(self.linked.origins()),
                        machine_icons: &machine_icons,
                        scratch_projects: &scratch_projects,
                        primary_machine_icon: self.primary_machine_icon(),
                        rect: self.thread_hover.row_rect(),
                    },
                    &mut self.sidebar_tree,
                    &self.tokens,
                    &self.geometry,
                    window,
                    cx,
                ))
                .child(self.render_seam(false, viewport_w, cx));
        }

        let maximized = self.layout.right_panel_open && self.right_panel_maximized;
        if !maximized {
            root = root.child(self.render_chat_column(viewport_h, cx));
        }

        if self.layout.right_panel_open {
            if !maximized {
                root = root.child(self.render_seam(true, viewport_w, cx));
            }
            root = root.child(self.render_right_panel_column(viewport_w, cx));
        }

        // A row held or swept (`SidebarPointerSensor`): window-level capture listeners follow the
        // pointer over any surface, end the gesture on release, and `Escape` cancels it.
        if self.pointer_captured() {
            let entity = cx.entity().downgrade();
            root = root.child(
                gpui_kit::canvas(
                    |_, _, _| {},
                    move |_, (), window, _| {
                        let move_entity = entity.clone();
                        window.on_mouse_event(
                            move |event: &gpui_kit::MouseMoveEvent, phase, _window, cx| {
                                if phase != gpui_kit::DispatchPhase::Capture {
                                    return;
                                }
                                let _ = move_entity.update(cx, |app, cx| {
                                    if event.pressed_button == Some(gpui_kit::MouseButton::Left) {
                                        app.sidebar_pointer_moved(event.position, cx);
                                    } else {
                                        // The button went up where nothing saw it.
                                        app.cancel_pointer_gesture(cx);
                                    }
                                });
                            },
                        );
                        let up_entity = entity;
                        window.on_mouse_event(
                            move |_: &gpui_kit::MouseUpEvent, phase, _window, cx| {
                                if phase != gpui_kit::DispatchPhase::Capture {
                                    return;
                                }
                                let _ = up_entity.update(cx, |app, cx| {
                                    app.sidebar_pointer_released(false, cx);
                                });
                            },
                        );
                    },
                )
                .absolute()
                .size_full(),
            );
        }

        // Seam drag-resize (`SidebarRail`): window-level capture listeners follow the pointer
        // over any surface (terminal, browser) and end the drag on release, even off-window.
        if self.seam_drag.is_some() {
            let entity = cx.entity().downgrade();
            root = root.child(
                gpui_kit::canvas(
                    |_, _, _| {},
                    move |_, (), window, _| {
                        let move_entity = entity.clone();
                        window.on_mouse_event(
                            move |event: &gpui_kit::MouseMoveEvent, phase, _window, cx| {
                                if phase != gpui_kit::DispatchPhase::Capture {
                                    return;
                                }
                                let _ = move_entity.update(cx, |app, cx| {
                                    let Some(drag) = app.seam_drag else {
                                        return;
                                    };
                                    if event.pressed_button == Some(gpui_kit::MouseButton::Left) {
                                        app.apply_seam_drag(
                                            drag,
                                            f32::from(event.position.x),
                                            f32::from(event.position.y),
                                            (viewport_w, viewport_h),
                                        );
                                    } else {
                                        app.seam_drag = None;
                                    }
                                    cx.notify();
                                });
                            },
                        );
                        let up_entity = entity.clone();
                        window.on_mouse_event(
                            move |_: &gpui_kit::MouseUpEvent, phase, _window, cx| {
                                if phase != gpui_kit::DispatchPhase::Capture {
                                    return;
                                }
                                let _ = up_entity.update(cx, |app, cx| {
                                    if let Some(drag) = app.seam_drag.take() {
                                        app.remember_seam_width(drag);
                                        app.save_thread_panels(cx);
                                        cx.notify();
                                    }
                                });
                            },
                        );
                    },
                )
                .absolute()
                .size_full(),
            );
        }

        if let Some(anchor) = &self.thread_menu
            && let Some(items) = self.thread_menu_items(anchor)
        {
            let anchor = anchor.clone();
            root = root.child(render_thread_action_menu(
                &items,
                &anchor,
                viewport,
                &self.thread_menu_focus,
                &self.tokens,
                cx,
            ));
        }

        if let Some(anchor) = &self.rail_menu {
            let anchor = anchor.clone();
            root = root.child(crate::sidebar::rail::render_rail_menu(
                &anchor,
                &self.tokens,
                cx,
            ));
        }

        if let Some(modal) = &self.settings_modal {
            root = root.child(crate::settings::render_overlay(modal));
        }
        if let Some(editor) = &self.workspace_editor {
            root = root.child(editor.clone());
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

/// Short label of a thread stream item for `CONN_GPUI_PERF_LOG` lines.
fn thread_stream_item_kind(item: &conn_state::ThreadStreamItem) -> &'static str {
    match item {
        conn_state::ThreadStreamItem::Snapshot(_) => "snapshot",
        conn_state::ThreadStreamItem::Synchronized(_) => "synchronized",
        conn_state::ThreadStreamItem::Event(_) | conn_state::ThreadStreamItem::Event2(_) => "event",
    }
}
