#![forbid(unsafe_code)]

//! Pure Rust state and reducers for `conn-gpui`.
//!
//! Intentionally free of GPUI and I/O dependencies so state transitions can be tested
//! deterministically and rapidly with `cargo test -p conn-state`.
//!
//! API contract (`conn-app` builds against these names; keep them stable):
//! - [`ShellState`]: projects and threads from `orchestration.subscribeShell`.
//! - [`ThreadState`]: one thread's timeline from `orchestration.subscribeThread`, flattened
//!   into [`TimelineEntry`] view models so views never touch raw contract events.
//! - [`LayoutState`]: sidebar, right panel, and tab layout.

pub use conn_contract::{
    OrchestrationProjectShell as ProjectShell, OrchestrationV2ShellStreamItem as ShellStreamItem,
    OrchestrationV2ThreadShell as ThreadShell, OrchestrationV2ThreadStreamItem as ThreadStreamItem,
};

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

/// What changed after applying one stream item, so the UI can repaint only what it must.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct ShellChange {
    pub projects_changed: bool,
    /// Thread ids added, updated, or removed.
    pub threads_changed: Vec<String>,
    /// The server asked for a fresh snapshot (`snapshot-required`); resubscribe without
    /// `afterSequence`.
    pub snapshot_required: bool,
}

/// Coarse run state of a thread for the sidebar dot/spinner.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ThreadActivity {
    Idle,
    Working,
    NeedsAttention,
    Failed,
}

/// Projects and threads from `orchestration.subscribeShell`.
#[derive(Clone, Debug, Default)]
pub struct ShellState {
    pub projects: Vec<ProjectShell>,
    pub threads: Vec<ThreadShell>,
    pub archived_threads: Vec<ThreadShell>,
    /// Last applied sequence; pass as `afterSequence` when resubscribing.
    pub sequence: Option<i64>,
    /// True once the server sent `synchronized`.
    pub synchronized: bool,
}

impl ShellState {
    /// Applies one `subscribeShell` stream item.
    pub fn apply(&mut self, item: ShellStreamItem) -> ShellChange {
        let _ = item;
        ShellChange::default()
    }

    /// Active threads of `project_id`, newest activity first.
    pub fn threads_for_project<'a>(
        &'a self,
        project_id: &'a str,
    ) -> impl Iterator<Item = &'a ThreadShell> + 'a {
        self.threads.iter().filter(move |t| t.project_id == project_id)
    }

    pub fn thread(&self, thread_id: &str) -> Option<&ThreadShell> {
        self.threads.iter().find(|t| t.id == thread_id)
    }

    pub fn project(&self, project_id: &str) -> Option<&ProjectShell> {
        self.projects.iter().find(|p| p.id == project_id)
    }

    /// Run state for the sidebar indicator.
    pub fn activity(&self, thread_id: &str) -> ThreadActivity {
        let _ = thread_id;
        ThreadActivity::Idle
    }
}

/// Status of a tool call or work item row.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ItemStatus {
    Running,
    Completed,
    Failed,
}

/// One row in the chat timeline. A flattened, render-ready model of the thread's turn items.
#[derive(Clone, Debug, PartialEq)]
pub enum TimelineEntry {
    User {
        id: String,
        text: String,
    },
    /// Assistant Markdown. `streaming` is true while deltas still arrive.
    Assistant {
        id: String,
        markdown: String,
        streaming: bool,
    },
    Thinking {
        id: String,
        text: String,
        streaming: bool,
    },
    /// A tool call / work log row (command, file edit, search, MCP call, ...).
    Tool {
        id: String,
        /// Short kind label used to pick the icon (`command`, `file_change`, `web_search`, ...).
        kind: String,
        title: String,
        detail: Option<String>,
        status: ItemStatus,
    },
    /// A pending approval or question the user must answer.
    Approval {
        id: String,
        title: String,
        detail: Option<String>,
    },
    /// An error or notice row.
    Notice {
        id: String,
        text: String,
        is_error: bool,
    },
}

impl TimelineEntry {
    pub fn id(&self) -> &str {
        match self {
            Self::User { id, .. }
            | Self::Assistant { id, .. }
            | Self::Thinking { id, .. }
            | Self::Tool { id, .. }
            | Self::Approval { id, .. }
            | Self::Notice { id, .. } => id,
        }
    }
}

/// One thread's timeline from `orchestration.subscribeThread`.
#[derive(Clone, Debug, Default)]
pub struct ThreadState {
    pub thread_id: String,
    pub entries: Vec<TimelineEntry>,
    /// True while a turn runs (show the working row and the Stop button).
    pub working: bool,
    pub sequence: Option<i64>,
    pub synchronized: bool,
}

impl ThreadState {
    pub fn new(thread_id: impl Into<String>) -> Self {
        Self {
            thread_id: thread_id.into(),
            ..Self::default()
        }
    }

    /// Applies one `subscribeThread` stream item. Returns true when entries changed.
    pub fn apply(&mut self, item: ThreadStreamItem) -> bool {
        let _ = item;
        false
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
            sidebar_width: 260.0,
            right_panel_open: false,
            right_panel_width: 480.0,
            right_panel_tab: RightPanelTab::Files,
            selected_project_id: None,
            selected_thread_id: None,
        }
    }
}
