//! Files right-panel surfaces, as Conn's `FileBrowserPanel` and `FilePreviewPanel`: the Files
//! tab is one full-width Pierre-themed lazy tree (`projects.listEntries`) under a soft search
//! field and `ToolbarGroup`; a file opens as its own tab showing a selectable syntax-highlighted
//! read-only preview (`projects.readFile`) under a breadcrumb subheader.

#[cfg(feature = "zed-files")]
mod navigation;

use crate::a11y::ConnA11yExt as _;
use std::fmt;

use conn_client::Connection;
use conn_contract::rpc::projects::{list_entries, read_file, search_entries};
use conn_contract::{
    ProjectEntryKind, ProjectListEntriesInput, ProjectReadFileInput, ProjectSearchEntriesInput,
};
use conn_theme::Tokens;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    Animation, AnimationExt as _, App, ClipboardItem, Context, Entity, InteractiveElement,
    IntoElement, MouseButton, MouseDownEvent, ParentElement, Pixels, Point, Render, SharedString,
    Styled, Subscription, Task, Transformation, Window, anchored, deferred, div, percentage, px,
};
use gpui_kit::{Image, ImageFormat, ImageSource, ObjectFit, img};
use std::sync::Arc;

use crate::chat::markdown::{MarkdownOptions, render_markdown};

use super::chrome::ConnTooltipExt as _;
use super::color::to_hsla;
use super::file_kind::{self, PreviewKind};
use super::file_path::{self, Crumb};
use super::header::superhero_icon;
use super::tree::FileTreeState;
use crate::header::details_card::EditorTarget;
use conn_contract::source::{SourceLines, SourceSelection};
use gpui_kit::component::input::{
    Editor, EditorState, RangeDecoration, RangeDecorationStyle, RopeExt as _,
};

/// Pierre tree compact row height (`FileBrowserPanel.tsx`: `itemHeight: 28`).
/// Space above the first source line in the preview.
const PREVIEW_TOP_PAD_PX: f32 = 6.0;
/// Width of the fade at a breadcrumb trail edge that has more crumbs beyond it.
const CRUMB_FADE_PX: f32 = 16.0;
const TREE_ROW_HEIGHT_PX: f32 = 28.0;
/// Pierre tree row radius (`pierre-tree-theme.ts`: `border-radius: 5px`).
const TREE_ROW_RADIUS_PX: f32 = 5.0;
/// Standard panel UI text size (`text-ui`: 13px / 20px).
const UI_TEXT_PX: f32 = 13.0;
const UI_LINE_HEIGHT_PX: f32 = 20.0;
const FILE_TEXT_INSET_PX: f32 = 12.0;
const CRUMB_PAD_PX: f32 = 2.0;
/// Breadcrumb font size (`text-sm`: 14px / 20px).
const BREADCRUMB_TEXT_PX: f32 = 14.0;
/// Panel toolbar metrics (`index.css`: `--spacing-toolbar: 7.5px`, `--spacing-toolbar-end: 11.5px`).
const TOOLBAR_PAD_Y_PX: f32 = 7.5;
const TOOLBAR_PAD_START_PX: f32 = 8.0;
const TOOLBAR_PAD_END_PX: f32 = 11.5;
const TOOLBAR_HEIGHT_PX: f32 = 32.0;
const TOOLBAR_INNER_PAD_PX: f32 = 3.0;
const TOOLBAR_BTN_SIZE_PX: f32 = 24.0;

#[derive(Clone, Debug)]
enum PreviewState {
    Empty,
    Loading(String),
    Loaded {
        path: String,
        raw_contents: String,
        truncated: bool,
    },
    Error {
        path: String,
        message: String,
    },
    /// An image the server sent as bytes.
    Image {
        path: String,
        image: Arc<Image>,
    },
    /// A file the Browser panel shows (a PDF): nothing is read here.
    Document {
        path: String,
    },
}

impl PreviewState {
    fn path(&self) -> Option<&str> {
        match self {
            Self::Empty => None,
            Self::Loading(path)
            | Self::Loaded { path, .. }
            | Self::Error { path, .. }
            | Self::Image { path, .. }
            | Self::Document { path } => Some(path),
        }
    }

    fn has_content(&self) -> bool {
        matches!(
            self,
            Self::Loaded { .. } | Self::Image { .. } | Self::Document { .. }
        )
    }
}

/// What the Files surfaces ask of the right panel.
#[derive(Clone, Debug)]
pub(crate) enum FilesEvent {
    DisplayedFileChanged,
    /// A file row was clicked: open the file as its own tab.
    OpenFile(String),
    /// A folder crumb was clicked: show the Files tree with that folder expanded and selected.
    RevealFolder,
    /// "Add to chat": put this mention at the end of the composer's draft.
    AddToChat(String),
    /// The Browser panel should show this URL (an HTML or PDF file's signed address).
    OpenInBrowser(String),
    Attach(SourceSelection),
    Definition(conn_contract::source::SourceLocation),
}

impl gpui_kit::EventEmitter<FilesEvent> for FilesPanel {}

/// A breadcrumb's folder menu: what the folder holds, one level at a time.
#[derive(Clone, Debug)]
struct CrumbMenu {
    /// The crumb's own folder: the menu cannot go back above it.
    root: String,
    /// The folder now listed.
    directory: String,
    position: Point<Pixels>,
    load: MenuLoad,
}

/// A file or folder's context menu (`showEntryContextMenu`), and the preview's `Open in` menu.
#[derive(Clone, Debug)]
struct RowMenu {
    path: String,
    position: Point<Pixels>,
}

/// The chip that follows the pointer while a row is dragged toward the composer.
struct MentionDragPreview {
    label: String,
    fg: gpui_kit::Hsla,
    bg: gpui_kit::Hsla,
}

impl Render for MentionDragPreview {
    fn render(&mut self, _: &mut Window, _: &mut Context<'_, Self>) -> impl IntoElement {
        div()
            .px(px(8.0))
            .py(px(3.0))
            .rounded(px(6.0))
            .bg(self.bg)
            .text_color(self.fg)
            .text_size(px(UI_TEXT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .child(self.label.clone())
    }
}

/// What a row of that menu does.
#[derive(Clone, Copy, Debug)]
enum RowAction {
    Open,
    Reveal,
    OpenWith(EditorTarget),
    CopyRelativePath,
    CopyFullPath,
    CopyMention,
    AddToChat,
}

#[derive(Clone, Debug)]
enum MenuLoad {
    Loading,
    Ready(Vec<conn_contract::ProjectEntry>),
    Failed,
}

/// Files explorer and read-only source preview panel.
pub(crate) struct FilesPanel {
    /// True while this entity draws a file tab (the preview), false for the Files tree.
    showing_preview: bool,
    tokens: Tokens,
    connection: Option<Connection>,
    workspace_root: Option<String>,
    thread: Option<String>,
    tree: FileTreeState,
    tree_error: Option<String>,
    preview: PreviewState,
    recent_text: std::collections::VecDeque<PreviewState>,
    pending_path: Option<String>,
    loading_hint: bool,
    word_wrap: bool,
    /// The Copy button shows a check for a moment after it copies (`useCopyToClipboard`).
    copied: bool,
    _copied_reset: Option<Task<()>>,
    editor: Option<Entity<EditorState>>,
    #[cfg(feature = "zed-files")]
    zed: Option<Entity<zed_editor::Editor>>,
    #[cfg(feature = "zed-files")]
    definition_press: Option<Point<Pixels>>,
    #[cfg(feature = "zed-files")]
    definition_lookup: Option<navigation::Lookup>,
    #[cfg(feature = "zed-files")]
    php_preparation: Option<Task<()>>,
    #[cfg(feature = "zed-files")]
    definition_file: Option<conn_contract::ProjectReadFileResult>,
    editor_subscription: Option<Subscription>,
    highlight: Option<gpui_kit::component::input::RangeDecorationCollection>,
    reveal: Option<PendingReveal>,
    range_error: Option<String>,
    search_input: Entity<InputState>,
    _subscriptions: Vec<Subscription>,
    context_generation: u64,
    preview_generation: u64,
    crumb_menu: Option<CrumbMenu>,
    menu_generation: u64,
    /// The thread whose workspace the files belong to: the server signs file addresses per thread.
    row_menu: Option<RowMenu>,
    /// The editor the `Open in` button uses: the last one picked from its menu.
    preferred_editor: Option<EditorTarget>,
    /// The breadcrumb trail's sideways scroll, and the path it was last scrolled to the end for.
    crumb_scroll: gpui_kit::ScrollHandle,
    crumbs_scrolled_for: std::cell::RefCell<Option<String>>,
    /// The preview's scroll, so an opened line can be brought to the middle.
    preview_scroll: gpui_kit::ScrollHandle,
    /// A line to reveal once the file has loaded, and the line now flashing.
    pending_reveal: Option<usize>,
    revealed_line: Option<usize>,
    _reveal_flash: Option<Task<()>>,
    /// `projects.searchEntries` for the query: the newest request wins, the list says whether more
    /// matches exist than it holds, and a failure shows a retry banner.
    search_generation: u64,
    search_pending: bool,
    search_truncated: bool,
    search_error: Option<String>,
    thread_id: Option<String>,
    /// The open file shows its rendered view (Markdown or table) instead of its source.
    render_preview: bool,
}

struct PendingReveal {
    lines: SourceLines,
    excerpt: Option<String>,
    done: tokio::sync::oneshot::Sender<Result<(), String>>,
}

impl fmt::Debug for FilesPanel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FilesPanel")
            .field("workspace_root", &self.workspace_root)
            .field("selected_path", &self.tree.selected())
            .finish_non_exhaustive()
    }
}

impl FilesPanel {
    pub(crate) fn new(
        tokens: Tokens,
        connection: Option<Connection>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Self {
        let search_input = cx.new(|cx| InputState::new(window, cx).placeholder("Search files"));
        let sub = cx.subscribe(&search_input, |this, input, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                let query = input.read(cx).value().to_string();
                this.tree.set_query(query);
                this.schedule_search(cx);
                cx.notify();
            }
        });
        Self {
            showing_preview: false,
            tokens,
            connection,
            workspace_root: None,
            thread: None,
            tree: FileTreeState::default(),
            tree_error: None,
            preview: PreviewState::Empty,
            recent_text: Default::default(),
            pending_path: None,
            loading_hint: false,
            word_wrap: false,
            copied: false,
            _copied_reset: None,
            editor: None,
            #[cfg(feature = "zed-files")]
            zed: None,
            #[cfg(feature = "zed-files")]
            definition_press: None,
            #[cfg(feature = "zed-files")]
            definition_lookup: None,
            #[cfg(feature = "zed-files")]
            php_preparation: None,
            #[cfg(feature = "zed-files")]
            definition_file: None,
            highlight: None,
            editor_subscription: None,
            reveal: None,
            range_error: None,
            search_input,
            _subscriptions: vec![sub],
            context_generation: 0,
            preview_generation: 0,
            crumb_menu: None,
            menu_generation: 0,
            row_menu: None,
            preferred_editor: None,
            crumb_scroll: gpui_kit::ScrollHandle::new(),
            crumbs_scrolled_for: std::cell::RefCell::new(None),
            preview_scroll: gpui_kit::ScrollHandle::new(),
            pending_reveal: None,
            revealed_line: None,
            _reveal_flash: None,
            search_generation: 0,
            search_pending: false,
            search_truncated: false,
            search_error: None,
            thread_id: None,
            render_preview: false,
        }
    }

    /// Sets the thread whose files are shown (file addresses are signed per thread).
    pub(crate) fn set_signing_thread(&mut self, thread_id: Option<String>) {
        self.thread_id = thread_id;
    }

    pub(crate) fn set_connection(
        &mut self,
        connection: Option<Connection>,
        cx: &mut Context<'_, Self>,
    ) {
        self.connection = connection;
        self.context_generation = self.context_generation.wrapping_add(1);
        self.tree.clear();
        self.tree_error = None;
        self.reset_preview(cx);
        cx.notify();
    }

    pub(super) fn set_thread(&mut self, thread: Option<String>, cx: &mut Context<'_, Self>) {
        self.thread = thread;
        self.reset_preview(cx);
    }

    pub(super) fn is_showing(&self, thread: &str, path: &str) -> bool {
        self.showing_preview
            && self.thread.as_deref() == Some(thread)
            && matches!(&self.preview,PreviewState::Loaded{path:current,..} if current==path)
    }

    pub(super) fn definition_error(&mut self, message: String, cx: &mut Context<'_, Self>) {
        self.range_error = Some(message);
        cx.notify();
    }

    pub(crate) fn reset_preview(&mut self, cx: &mut Context<'_, Self>) {
        self.preview_generation = self.preview_generation.wrapping_add(1);
        self.preview = PreviewState::Empty;
        self.recent_text.clear();
        self.pending_path = None;
        self.editor = None;
        #[cfg(feature = "zed-files")]
        {
            self.zed = None;
            self.definition_file = None;
            self.php_preparation = None;
            self.definition_lookup = None;
            self.definition_press = None;
        }
        self.editor_subscription = None;
        self.highlight = None;
        self.reveal = None;
        self.range_error = None;
        cx.notify();
    }

    pub(crate) fn cancel_reveal(&mut self) {
        self.reveal = None;
        #[cfg(feature = "zed-files")]
        {
            self.definition_lookup = None;
            self.definition_file = None;
        }
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens;
        cx.notify();
    }

    pub(crate) fn set_workspace_root(
        &mut self,
        workspace_root: Option<String>,
        cx: &mut Context<'_, Self>,
    ) {
        if self.workspace_root == workspace_root {
            return;
        }
        self.workspace_root = workspace_root;
        self.context_generation = self.context_generation.wrapping_add(1);
        self.tree.clear();
        self.tree_error = None;
        self.reset_preview(cx);
        if self.workspace_root.is_some() {
            self.load_directory(String::new(), cx);
        }
        cx.notify();
    }

    /// Searches the workspace for the query on the server after a short pause
    /// (`useProjectPathSearch`: 120 ms debounce, 256 characters, 200 matches).
    fn schedule_search(&mut self, cx: &mut Context<'_, Self>) {
        self.search_generation = self.search_generation.wrapping_add(1);
        let generation = self.search_generation;
        let query: String = self.tree.query().trim().chars().take(256).collect();
        self.search_error = None;
        self.search_truncated = false;
        if query.is_empty() {
            self.tree.clear_search();
            self.search_pending = false;
            return;
        }
        let (Some(conn), Some(cwd)) = (self.connection.clone(), self.workspace_root.clone()) else {
            self.search_pending = false;
            return;
        };
        self.search_pending = true;
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(120))
                .await;
            let current = this
                .update(cx, |panel, _| panel.search_generation == generation)
                .unwrap_or(false);
            if !current {
                return;
            }
            let payload = ProjectSearchEntriesInput {
                cwd,
                query,
                limit: 200,
                kind: None,
                image_only: None,
            };
            let res = conn
                .call::<search_entries::Payload, search_entries::Success>(
                    "projects.searchEntries",
                    &payload,
                )
                .await;
            let _ = this.update(cx, |panel, cx| {
                if panel.search_generation != generation {
                    return;
                }
                panel.search_pending = false;
                match res {
                    Ok(result) => {
                        panel.tree.set_search_results(&result.entries);
                        panel.search_truncated = result.truncated;
                    }
                    Err(err) => {
                        panel.tree.clear_search();
                        panel.search_error = Some(err.to_string());
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// Shows the Copy button's check for 1.2 seconds (`useCopyToClipboard`'s `timeout`).
    fn show_copied(&mut self, cx: &mut Context<'_, Self>) {
        self.copied = true;
        self._copied_reset = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(1_200))
                .await;
            let _ = this.update(cx, |panel, cx| {
                panel.copied = false;
                cx.notify();
            });
        }));
        cx.notify();
    }

    /// The project's name for the root crumb: the workspace folder's name.
    fn project_name(&self) -> String {
        self.workspace_root
            .as_deref()
            .and_then(|root| root.trim_end_matches('/').rsplit('/').next())
            .filter(|name| !name.is_empty())
            .unwrap_or("Project")
            .to_owned()
    }

    /// Shows the Files tree with `folder` expanded and selected (a folder crumb was clicked).
    fn reveal_folder(&mut self, folder: String, cx: &mut Context<'_, Self>) {
        self.crumb_menu = None;
        for directory in self.tree.reveal_folder(&folder) {
            self.load_directory(directory, cx);
        }
        cx.emit(FilesEvent::RevealFolder);
        cx.notify();
    }

    /// Opens the folder menu of the crumb whose folder is `root`, at `position`.
    fn open_crumb_menu(
        &mut self,
        root: String,
        position: Point<Pixels>,
        cx: &mut Context<'_, Self>,
    ) {
        if self.crumb_menu.as_ref().is_some_and(|m| m.root == root) {
            self.crumb_menu = None;
            cx.notify();
            return;
        }
        self.crumb_menu = Some(CrumbMenu {
            root: root.clone(),
            directory: root.clone(),
            position,
            load: MenuLoad::Loading,
        });
        self.load_crumb_menu(root, cx);
    }

    /// Lists `directory` in the open crumb menu (`projects.listEntries`).
    fn load_crumb_menu(&mut self, directory: String, cx: &mut Context<'_, Self>) {
        let (Some(conn), Some(cwd)) = (self.connection.clone(), self.workspace_root.clone()) else {
            if let Some(menu) = &mut self.crumb_menu {
                menu.load = MenuLoad::Failed;
            }
            cx.notify();
            return;
        };
        if let Some(menu) = &mut self.crumb_menu {
            menu.directory = directory.clone();
            menu.load = MenuLoad::Loading;
        }
        self.menu_generation = self.menu_generation.wrapping_add(1);
        let generation = self.menu_generation;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let payload = ProjectListEntriesInput {
                cwd,
                directory_path: Some(directory.clone()),
            };
            let res = conn
                .call::<list_entries::Payload, list_entries::Success>(
                    "projects.listEntries",
                    &payload,
                )
                .await;
            let _ = this.update(cx, |panel, cx| {
                if panel.menu_generation != generation {
                    return;
                }
                if let Some(menu) = &mut panel.crumb_menu {
                    menu.load = match res {
                        Ok(result) => MenuLoad::Ready(result.entries),
                        Err(_) => MenuLoad::Failed,
                    };
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn refresh_files(&mut self, cx: &mut Context<'_, Self>) {
        if self.workspace_root.is_none() {
            return;
        }
        let expanded = self.tree.expanded_directories();
        if !self.tree.query().trim().is_empty() {
            self.schedule_search(cx);
        }
        self.load_directory(String::new(), cx);
        for dir in expanded {
            self.load_directory(dir, cx);
        }
        if let PreviewState::Loaded { path, .. } = &self.preview {
            let path = path.clone();
            self.open_file(path, cx);
        }
    }

    fn toggle_expand_all(&mut self, cx: &mut Context<'_, Self>) {
        if self.tree.all_directories_expanded() {
            self.tree.collapse_all_directories();
            cx.notify();
        } else {
            let to_load = self.tree.expand_all_directories();
            for dir in to_load {
                self.load_directory(dir, cx);
            }
            cx.notify();
        }
    }

    fn load_directory(&mut self, directory: String, cx: &mut Context<'_, Self>) {
        let (Some(conn), Some(cwd)) = (self.connection.clone(), self.workspace_root.clone()) else {
            return;
        };
        let generation = self.context_generation;
        self.tree.mark_loading(&directory);
        if directory.is_empty() {
            self.tree_error = None;
        }
        cx.notify();

        let dir_for_req = directory.clone();
        cx.spawn(async move |this, cx| {
            let payload = ProjectListEntriesInput {
                cwd,
                directory_path: Some(dir_for_req),
            };
            let res = conn
                .call::<list_entries::Payload, list_entries::Success>(
                    "projects.listEntries",
                    &payload,
                )
                .await;
            let _ = this.update(cx, |panel, cx| {
                if panel.context_generation != generation {
                    return;
                }
                match res {
                    Ok(result) => {
                        panel.tree.set_directory_entries(&directory, result.entries);
                        if directory.is_empty() {
                            panel.tree_error = None;
                        }
                    }
                    Err(err) => {
                        panel.tree.clear_loading(&directory);
                        if directory.is_empty() {
                            panel.tree_error = Some(err.to_string());
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Draws the Files tree.
    pub(crate) fn show_tree(&mut self, cx: &mut Context<'_, Self>) {
        self.showing_preview = false;
        #[cfg(feature = "zed-files")]
        {
            self.definition_lookup = None;
        }
        cx.notify();
    }

    /// Draws the file tab for `path`, which may end in `:line` or `:line:column`: the line is
    /// scrolled to the middle and flashes (`revealLine`).
    pub(crate) fn show_preview_at(&mut self, path: String, cx: &mut Context<'_, Self>) {
        let (file, line) = file_path::split_line_suffix(&path);
        let (file, line) = (file.to_owned(), line);
        self.pending_reveal = line;
        let already_loaded =
            matches!(&self.preview, PreviewState::Loaded { path, .. } if *path == file);
        self.show_preview(file, cx);
        if already_loaded {
            self.apply_pending_reveal(cx);
        }
    }

    /// Reveals `line` of the open file, now or when it has loaded (a chat link to `a.rs:42`).
    pub(crate) fn reveal_line(&mut self, line: usize, cx: &mut Context<'_, Self>) {
        self.pending_reveal = Some(line);
        self.apply_pending_reveal(cx);
    }

    /// Scrolls the pending line to the middle of the preview and flashes it for a moment.
    fn apply_pending_reveal(&mut self, cx: &mut Context<'_, Self>) {
        if self.held_file().is_some() {
            return;
        }
        let PreviewState::Loaded { raw_contents, .. } = &self.preview else {
            return;
        };
        let line_count = raw_contents.lines().count().max(1);
        let Some(line) = self.pending_reveal.take() else {
            return;
        };
        let line = line.clamp(1, line_count);
        let viewport = f32::from(self.preview_scroll.bounds().size.height);
        let top = PREVIEW_TOP_PAD_PX + (line - 1) as f32 * UI_LINE_HEIGHT_PX;
        let offset = (top - (viewport - UI_LINE_HEIGHT_PX) / 2.0).max(0.0);
        self.preview_scroll
            .set_offset(gpui_kit::point(px(0.0), px(-offset)));
        self.revealed_line = Some(line);
        self._reveal_flash = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(1_600))
                .await;
            let _ = this.update(cx, |panel, cx| {
                panel.revealed_line = None;
                cx.notify();
            });
        }));
        cx.notify();
    }

    /// Draws the file tab for `path`, loading it unless it is already shown.
    pub(crate) fn show_preview(&mut self, path: String, cx: &mut Context<'_, Self>) {
        let was_visible = self.showing_preview;
        self.showing_preview = true;
        let needs_read =
            self.pending_path.as_deref().or_else(|| self.preview.path()) != Some(path.as_str());
        if !was_visible && self.preview.path() != Some(&path) && self.preview.has_content() {
            self.present(PreviewState::Loading(path.clone()), cx);
            self.loading_hint = true;
        }
        if needs_read {
            self.open_file(path, cx);
        } else {
            cx.notify();
        }
    }

    pub(super) fn held_file(&self) -> Option<&str> {
        let requested = self.pending_path.as_deref()?;
        self.preview
            .path()
            .filter(|shown| self.preview.has_content() && *shown != requested)
    }

    #[cfg(feature = "automation")]
    pub(crate) fn spike_files_state(&self, window: &Window, cx: &App) -> serde_json::Value {
        use gpui_kit::Focusable as _;
        let path = match &self.preview {
            PreviewState::Loaded { path, .. } => Some(path),
            _ => None,
        };
        let ready = self.editor.is_some();
        let focused = self
            .editor
            .as_ref()
            .is_some_and(|e| e.read(cx).focus_handle(cx).is_focused(window));
        #[cfg(feature = "zed-files")]
        let (ready, focused) = self.zed.as_ref().map_or((ready, focused), |e| {
            (true, e.read(cx).focus_handle(cx).is_focused(window))
        });
        let state = serde_json::json!({"path":path,"ready":ready,"focused":focused,"selected":self.selected_source(cx),"thread":self.thread,"pendingPath":self.pending_path,"previewPath":self.preview.path()});
        #[cfg(feature = "zed-files")]
        let state = {
            let mut state = state;
            state["hoverReady"] = self
                .definition_lookup
                .as_ref()
                .is_some_and(navigation::Lookup::has_target)
                .into();
            state
        };
        state
    }
    fn has_selection(&self, cx: &App) -> bool {
        #[cfg(feature = "zed-files")]
        if let Some(editor) = &self.zed {
            let editor = editor.read(cx);
            let selection = editor.selections.newest_anchor();
            return selection.start != selection.end
                && !super::zed_preview::selection(editor, cx).is_empty();
        }
        self.editor
            .as_ref()
            .is_some_and(|editor| !editor.read(cx).selected_range().is_empty())
    }

    pub(crate) fn selected_source(&self, cx: &App) -> Option<SourceSelection> {
        let PreviewState::Loaded {
            path,
            #[cfg(feature = "zed-files")]
            raw_contents,
            ..
        } = &self.preview
        else {
            return None;
        };
        #[cfg(feature = "zed-files")]
        if let Some(zed) = &self.zed {
            let range = super::zed_preview::selection(zed.read(cx), cx);
            if range.is_empty() {
                return None;
            }
            let raw_contents = zed_text::LineEnding::normalize_cow(raw_contents.as_str().into());
            return Some(SourceSelection {
                path: path.clone(),
                lines: SourceLines::from_selection(&raw_contents, range.clone())?,
                text: raw_contents.get(range)?.into(),
            });
        }
        let editor = self.editor.as_ref()?.read(cx);
        let range = editor.selected_range();
        if range.is_empty() {
            return None;
        }
        let text = editor.value();
        Some(SourceSelection {
            path: path.clone(),
            lines: SourceLines::from_selection(&text, range.clone())?,
            text: text.get(range)?.to_owned(),
        })
    }

    pub(crate) fn reveal_lines(
        &mut self,
        path: String,
        lines: SourceLines,
        excerpt: Option<String>,
        cx: &mut Context<'_, Self>,
    ) -> tokio::sync::oneshot::Receiver<Result<(), String>> {
        let (done, receiver) = tokio::sync::oneshot::channel();
        let reading = self.pending_path.as_deref() == Some(&path);
        let displayed =
            matches!(&self.preview, PreviewState::Loaded {path: current, ..} if current == &path);
        if !reading && (self.pending_path.is_some() || excerpt.is_some() || !displayed) {
            self.open_file(path, cx);
        }
        if let PreviewState::Error { message, .. } = &self.preview {
            let _ = done.send(Err(message.clone()));
        } else {
            self.reveal = Some(PendingReveal {
                lines,
                excerpt,
                done,
            });
        }
        receiver
    }

    fn remember_text(&mut self, preview: PreviewState) {
        if let PreviewState::Loaded {
            path, raw_contents, ..
        } = &preview
            && raw_contents.len() <= 512 * 1024
        {
            self.recent_text.retain(
                |p| !matches!(p, PreviewState::Loaded { path: other, .. } if other == path),
            );
            self.recent_text.push_front(preview);
            self.recent_text.truncate(8);
        }
    }

    pub(super) fn release_closed_file(&mut self, path: &str, cx: &mut Context<'_, Self>) {
        if self.held_file() == Some(path)
            && let Some(pending) = self.pending_path.clone()
        {
            self.present(PreviewState::Loading(pending), cx);
            self.loading_hint = true;
        }
    }

    fn present(&mut self, next: PreviewState, cx: &mut Context<'_, Self>) {
        let switched = self.preview.path() != next.path();
        let unchanged = matches!((&self.preview, &next),
            (PreviewState::Loaded {raw_contents: a, truncated: ta, ..}, PreviewState::Loaded {raw_contents: b, truncated: tb, ..})
            if !switched && a == b && ta == tb);
        if !unchanged {
            self.editor = None;
            self.editor_subscription = None;
            #[cfg(feature = "zed-files")]
            {
                self.zed = None;
                self.definition_lookup = None;
                self.definition_press = None;
            }
            if let Some(highlight) = self.highlight.take() {
                highlight.dispose(cx);
            }
            self.revealed_line = None;
            self._reveal_flash = None;
        }
        if switched {
            self.recent_text.retain(|entry| entry.path() != next.path());
            self.render_preview = next
                .path()
                .is_some_and(|path| file_kind::preview_kind(path).rendered_by_default());
            self.crumb_menu = None;
        }
        let previous = std::mem::replace(&mut self.preview, next);
        if switched {
            self.remember_text(previous);
            cx.emit(FilesEvent::DisplayedFileChanged);
        }
        cx.notify();
    }

    fn open_file(&mut self, path: String, cx: &mut Context<'_, Self>) {
        self.preview_generation = self.preview_generation.wrapping_add(1);
        let generation = self.preview_generation;
        self.pending_path = None;
        #[cfg(feature = "zed-files")]
        {
            self.definition_lookup = None;
            self.definition_press = None;
        }
        self.reveal = None;
        self.range_error = None;
        if let Some(parent) = std::path::Path::new(&path).parent() {
            for dir in parent
                .ancestors()
                .filter_map(|p| p.to_str())
                .filter(|p| !p.is_empty())
            {
                if self.tree.expand(dir) {
                    self.load_directory(dir.to_owned(), cx);
                }
            }
        }
        self.tree.select(Some(path.clone()));
        let (Some(conn), Some(cwd)) = (self.connection.clone(), self.workspace_root.clone()) else {
            self.present(
                PreviewState::Error {
                    path,
                    message: "Not connected to server.".into(),
                },
                cx,
            );
            return;
        };
        #[cfg(feature = "zed-files")]
        if self.php_preparation.is_none()
            && super::zed_preview::enabled()
            && path.ends_with(".php")
            && !path.ends_with(".blade.php")
            && let Some(thread) = self.thread.clone()
        {
            let conn = conn.clone();
            let doc = conn_contract::source::PreparePhpNavigation {
                thread_id: thread,
                path: path.clone(),
            };
            self.php_preparation = Some(cx.spawn(async move |this, cx| {
                if conn.prepare_php_navigation(doc).await.is_err() {
                    let _ = this.update(cx, |panel, _| panel.php_preparation = None);
                }
            }));
        }
        let kind = file_kind::preview_kind(&path);
        if kind == PreviewKind::Pdf {
            self.present(PreviewState::Document { path }, cx);
            return;
        }
        #[cfg(feature = "zed-files")]
        if let Some(file) = self.definition_file.take()
            && file.relative_path == path
        {
            self.present(
                PreviewState::Loaded {
                    path,
                    raw_contents: file.contents,
                    truncated: file.truncated,
                },
                cx,
            );
            self.apply_pending_reveal(cx);
            return;
        }
        self.pending_path = Some(path.clone());
        if let Some(index) = self
            .recent_text
            .iter()
            .position(|p| p.path() == Some(&path))
            && let Some(cached) = self.recent_text.remove(index)
        {
            self.present(cached, cx);
        } else if !self.preview.has_content() {
            self.present(PreviewState::Loading(path.clone()), cx);
            self.loading_hint = false;
            cx.spawn(async move |this, cx| {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(150))
                    .await;
                let _ = this.update(cx, |panel, cx| {
                    if panel.preview_generation == generation
                        && matches!(panel.preview, PreviewState::Loading(_))
                    {
                        panel.loading_hint = true;
                        cx.notify();
                    }
                });
            })
            .detach();
        }
        if let PreviewKind::Image(mime) = kind {
            self.load_image(conn, path, mime, generation, cx);
            return;
        }
        let rel_path = path.clone();
        cx.spawn(async move |this, cx| {
            let payload = ProjectReadFileInput {
                cwd,
                relative_path: rel_path,
                allow_missing: None,
            };
            let res = conn
                .call::<read_file::Payload, read_file::Success>("projects.readFile", &payload)
                .await;
            let _ = this.update(cx, |panel, cx| {
                if panel.preview_generation != generation {
                    return;
                }
                panel.pending_path = None;
                match res {
                    Ok(result) => {
                        panel.present(
                            PreviewState::Loaded {
                                path,
                                raw_contents: result.contents,
                                truncated: result.truncated,
                            },
                            cx,
                        );
                        panel.apply_pending_reveal(cx);
                    }
                    Err(err) => {
                        if let Some(reveal) = panel.reveal.take() {
                            let _ = reveal.done.send(Err(err.to_string()));
                        }
                        panel.present(
                            PreviewState::Error {
                                path,
                                message: err.to_string(),
                            },
                            cx,
                        );
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Downloads an image through a signed asset address and shows it (`PreviewImage`).
    fn load_image(
        &mut self,
        conn: Connection,
        path: String,
        mime: &'static str,
        generation: u64,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(thread_id) = self.thread_id.clone() else {
            self.pending_path = None;
            self.present(
                PreviewState::Error {
                    path,
                    message: "Open a thread to preview images.".to_owned(),
                },
                cx,
            );
            return;
        };
        cx.spawn(async move |this, cx| {
            let res = conn.fetch_workspace_file_bytes(&thread_id, &path).await;
            let _ = this.update(cx, |panel, cx| {
                if panel.preview_generation != generation {
                    return;
                }
                panel.pending_path = None;
                let preview = match res {
                    Ok(bytes) => match image_format(mime) {
                        Some(format) => PreviewState::Image {
                            path,
                            image: Arc::new(Image::from_bytes(format, bytes)),
                        },
                        None => PreviewState::Error {
                            path,
                            message: "This image type cannot be shown.".to_owned(),
                        },
                    },
                    Err(err) => PreviewState::Error {
                        path,
                        message: err.to_string(),
                    },
                };
                panel.present(preview, cx);
            });
        })
        .detach();
    }

    /// Asks the Browser panel to show the open file (`openFileInPreview`): the server signs an
    /// address for it, and Chromium renders the page or the PDF.
    fn open_in_browser(&mut self, cx: &mut Context<'_, Self>) {
        let (Some(conn), Some(thread_id)) = (self.connection.clone(), self.thread_id.clone())
        else {
            return;
        };
        let path = match &self.preview {
            PreviewState::Loaded { path, .. } | PreviewState::Document { path } => path.clone(),
            _ => return,
        };
        cx.spawn(async move |this, cx| {
            if let Ok(url) = conn.workspace_file_url(&thread_id, &path).await {
                let _ = this.update(cx, |_, cx| {
                    cx.emit(FilesEvent::OpenInBrowser(url.to_string()));
                });
            }
        })
        .detach();
    }

    /// One round button of the preview toolbar's group; a pressed toggle brightens its glyph.
    fn toolbar_button(
        &self,
        id: &'static str,
        ax_id: &'static str,
        label: &str,
        icon: &'static str,
        pressed: bool,
        on_press: impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static,
    ) -> impl IntoElement {
        let hover_bg = to_hsla(self.tokens.shell_highlight);
        let color = if pressed {
            to_hsla(self.tokens.foreground)
        } else {
            to_hsla(self.tokens.muted_foreground)
        };
        div()
            .id(id)
            .a11y_button(ax_id, label.to_owned())
            .conn_tooltip(label.to_owned(), &self.tokens)
            .size(px(TOOLBAR_BTN_SIZE_PX))
            .rounded(px(9999.0))
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .hover(move |s| s.bg(hover_bg))
            .on_mouse_down(MouseButton::Left, on_press)
            .child(superhero_icon(icon, 14.0, color))
    }

    fn render_tree_toolbar(&self, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let field_bg = to_hsla(self.tokens.shell_field);
        let control_bg = to_hsla(self.tokens.shell_control);
        let control_border = to_hsla(self.tokens.shell_divider_header);
        let hover_bg = to_hsla(self.tokens.shell_highlight);
        let muted = to_hsla(self.tokens.muted_foreground);

        // `RefreshIcon refreshing={isPending}`: the refresh glyph spins while files load.
        let refreshing = self.tree.is_loading() || self.search_pending;
        let refresh_icon = superhero_icon("superhero/refresh.svg", 14.0, muted);
        let refresh_icon = if refreshing {
            refresh_icon
                .with_animation(
                    "files-refresh-spin",
                    Animation::new(std::time::Duration::from_secs(1)).repeat(),
                    |icon, delta| {
                        icon.with_transformation(Transformation::rotate(percentage(delta)))
                    },
                )
                .into_any_element()
        } else {
            refresh_icon.into_any_element()
        };
        let all_expanded = self.tree.all_directories_expanded();
        let has_dirs = self.tree.has_directories();
        let expand_icon = if all_expanded {
            "superhero/chevrons-down-up.svg"
        } else {
            "superhero/chevrons-up-down.svg"
        };

        // Explorer toolbar sits directly over the 256px tree column so the soft search field
        // starts 8px from the panel edge and its search icon aligns at 16px with the tree icons.
        let mut explorer_actions = h_flex()
            .flex_shrink_0()
            .h(px(TOOLBAR_HEIGHT_PX))
            .px(px(TOOLBAR_INNER_PAD_PX))
            .gap(px(2.0))
            .items_center()
            .rounded(px(9999.0))
            .bg(control_bg)
            .border_1()
            .border_color(control_border)
            .child(
                div()
                    .id("files-refresh-btn")
                    .a11y_button("panel.files.refresh", "Refresh workspace files")
                    .size(px(TOOLBAR_BTN_SIZE_PX))
                    .rounded(px(9999.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover_bg))
                    .conn_tooltip(
                        if refreshing {
                            "Refreshing\u{2026}"
                        } else {
                            "Refresh files"
                        },
                        &self.tokens,
                    )
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, _, _, cx| this.refresh_files(cx)),
                    )
                    .child(refresh_icon),
            );

        if has_dirs {
            explorer_actions = explorer_actions.child(
                div()
                    .id("files-toggle-expand-btn")
                    .a11y_button(
                        "panel.files.toggle-expand",
                        if all_expanded {
                            "Collapse all folders"
                        } else {
                            "Expand all folders"
                        },
                    )
                    .conn_tooltip(
                        if all_expanded {
                            "Collapse all folders"
                        } else {
                            "Expand all folders"
                        },
                        &self.tokens,
                    )
                    .size(px(TOOLBAR_BTN_SIZE_PX))
                    .rounded(px(9999.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover_bg))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, _, _, cx| this.toggle_expand_all(cx)),
                    )
                    .child(superhero_icon(expand_icon, 14.0, muted)),
            );
        }

        // `FileBrowserPanel` subheader: `py-toolbar ps-2 pe-toolbar-end gap-2`; inline its
        // bottom border is transparent (it keeps its 1px).
        h_flex()
            .w_full()
            .flex_shrink_0()
            .py(px(TOOLBAR_PAD_Y_PX))
            .pl(px(TOOLBAR_PAD_START_PX))
            .pr(px(TOOLBAR_PAD_END_PX))
            .border_b_1()
            .border_color(gpui_kit::transparent_black())
            .items_center()
            .gap(px(8.0))
            .child(
                // Soft search field (`InputGroup variant="soft"`): h-8, pill radius, --shell-field fill.
                h_flex()
                    .flex_1()
                    .min_w_0()
                    .h(px(TOOLBAR_HEIGHT_PX))
                    .rounded(px(9999.0))
                    .bg(field_bg)
                    .border_1()
                    .border_color(control_border)
                    .pl(px(8.0))
                    .pr(px(10.0))
                    .gap(px(6.0))
                    .items_center()
                    // `FileSearchField`: Escape clears the search and leaves the field.
                    .on_key_down(cx.listener(|this, event: &gpui_kit::KeyDownEvent, window, cx| {
                        if event.keystroke.key == "escape" {
                            this.search_input
                                .update(cx, |input, cx| input.set_value("", window, cx));
                            window.blur(cx);
                            cx.stop_propagation();
                        }
                    }))
                    .child(superhero_icon("superhero/search.svg", 14.0, muted))
                    .child(
                        div().flex_1().min_w_0().child(
                            Input::new(&self.search_input)
                                .appearance(false)
                                .text_size(px(UI_TEXT_PX)),
                        ),
                    ),
            )
            .child(explorer_actions)
    }

    fn render_preview_subheader(&self, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let fg = to_hsla(self.tokens.foreground);
        let muted = to_hsla(self.tokens.muted_foreground);
        let mut row = h_flex()
            .w_full()
            .flex_shrink_0()
            .h(px(36.0))
            .pl(px(FILE_TEXT_INSET_PX - CRUMB_PAD_PX))
            .pr(px(FILE_TEXT_INSET_PX))
            .border_b_1()
            .border_color(to_hsla(self.tokens.shell_divider_header))
            .items_center();
        if let Some(path) = self.preview.path() {
            row = row
                .child(self.render_breadcrumbs(path, fg, muted, cx))
                .children(self.render_crumb_menu(path, cx));
        }
        row
    }

    fn render_preview_actions(&self, cx: &mut Context<'_, Self>) -> Option<impl IntoElement> {
        let path = self.preview.path()?;
        let control_bg = to_hsla(self.tokens.shell_card).blend(to_hsla(self.tokens.shell_control));
        let control_border = to_hsla(self.tokens.shell_divider_header);
        let kind = file_kind::preview_kind(path);
        let loaded = matches!(self.preview, PreviewState::Loaded { .. });
        let document = matches!(self.preview, PreviewState::Document { .. });
        let rendered = kind.has_rendered_view() && self.render_preview;
        let mut group = h_flex()
            .absolute()
            .top(px(8.0))
            .right(px(8.0))
            .occlude()
            .flex_shrink_0()
            .h(px(TOOLBAR_HEIGHT_PX))
            .px(px(TOOLBAR_INNER_PAD_PX))
            .gap(px(2.0))
            .items_center()
            .rounded(px(9999.0))
            .bg(control_bg)
            .border_1()
            .border_color(control_border);
        let mut buttons = 0;
        if loaded && kind.has_rendered_view() {
            let (icon, label) = if self.render_preview {
                ("superhero/code.svg", "Show source")
            } else if matches!(kind, PreviewKind::Markdown) {
                ("superhero/show.svg", "Preview Markdown")
            } else {
                ("superhero/table.svg", "Show table")
            };
            group = group.child(self.toolbar_button(
                "files-preview-render-btn",
                "panel.files.preview-render",
                label,
                icon,
                self.render_preview,
                cx.listener(|this, _, _, cx| {
                    this.render_preview = !this.render_preview;
                    cx.notify();
                }),
            ));
            buttons += 1;
        }
        if loaded && !rendered {
            group = group.child(self.toolbar_button(
                "files-preview-wrap-btn",
                "panel.files.preview-wrap",
                if self.word_wrap {
                    "Disable word wrap"
                } else {
                    "Enable word wrap"
                },
                "superhero/wrap-lines.svg",
                self.word_wrap,
                cx.listener(|this, _, _, cx| {
                    this.word_wrap = !this.word_wrap;
                    #[cfg(feature = "zed-files")]
                    if let Some(editor) = &this.zed {
                        editor.update(cx, |e, cx| {
                            super::zed_preview::set_wrap(e, this.word_wrap, cx)
                        });
                    }
                    cx.notify();
                }),
            ));
            buttons += 1;
        }
        if loaded {
            group = group.child(self.toolbar_button(
                "files-preview-copy-btn",
                "panel.files.preview-copy",
                if self.copied {
                    "Copied"
                } else {
                    "Copy contents"
                },
                if self.copied {
                    "superhero/check.svg"
                } else {
                    "superhero/copy.svg"
                },
                self.copied,
                cx.listener(|this, _, _, cx| {
                    if let PreviewState::Loaded { raw_contents, .. } = &this.preview {
                        cx.write_to_clipboard(ClipboardItem::new_string(raw_contents.clone()));
                        this.show_copied(cx);
                    }
                }),
            ));
            buttons += 1;
        }
        if loaded || document {
            // `OpenInPicker`: a button that opens the file in the editor picked last
            // (Cursor to begin with), and a chevron with every action.
            let local = self.workspace_root.as_deref().is_some_and(|root| {
                std::path::Path::new(&file_path::absolute_path(root, path)).exists()
            });
            if local {
                let editor = self.preferred_editor.unwrap_or(EditorTarget::Cursor);
                let open_path = path.to_owned();
                group = group.child(self.toolbar_button(
                    "files-preview-open-in-btn",
                    "panel.files.preview-open-in",
                    &format!("Open in {}", editor.label()),
                    "superhero/external-link.svg",
                    false,
                    cx.listener(move |this, _, _, cx| {
                        this.run_row_action(RowAction::OpenWith(editor), &open_path, cx);
                    }),
                ));
                buttons += 1;
            }
            let menu_path = path.to_owned();
            group = group.child(self.toolbar_button(
                "files-preview-open-in-menu-btn",
                "panel.files.preview-open-in-menu",
                "More ways to open",
                "superhero/chevron-down.svg",
                self.row_menu.is_some(),
                cx.listener(move |this, event: &MouseDownEvent, _, cx| {
                    cx.stop_propagation();
                    this.row_menu = Some(RowMenu {
                        path: menu_path.clone(),
                        position: event.position,
                    });
                    cx.notify();
                }),
            ));
            buttons += 1;
        }
        if kind.opens_in_browser() && (loaded || document) {
            group = group.child(self.toolbar_button(
                "files-preview-browser-btn",
                "panel.files.preview-browser",
                "Open file in browser",
                "superhero/globe.svg",
                false,
                cx.listener(|this, _, _, cx| this.open_in_browser(cx)),
            ));
            buttons += 1;
        }
        if self.has_selection(cx) {
            group = group.child(self.toolbar_button(
                "files-preview-attach-btn",
                "panel.files.attach",
                "Add selection",
                "superhero/attach.svg",
                false,
                cx.listener(|panel, _, _, cx| {
                    if let Some(source) = panel.selected_source(cx) {
                        cx.emit(FilesEvent::Attach(source));
                    }
                }),
            ));
            buttons += 1;
        }
        (buttons > 0).then_some(group)
    }

    fn render_tree_column(&self, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let muted = to_hsla(self.tokens.muted_foreground);
        let fg = to_hsla(self.tokens.foreground);
        // Pierre tree theme (`pierre-tree-theme.ts`):
        // --trees-hover-bg-override: var(--shell-highlight)
        // --trees-selected-bg-override: color-mix(in srgb, var(--foreground) 11%, transparent)
        let hover_bg = to_hsla(self.tokens.shell_highlight);
        let selected_bg = to_hsla(self.tokens.foreground.with_alpha(0.11));

        let mut col = v_flex()
            .id("files-tree-scroll")
            .a11y_group("panel.files.tree", "File tree")
            .flex_1()
            .min_h_0()
            .w_full()
            .overflow_y_scroll()
            .py(px(4.0))
            .px(px(6.0));

        if self.workspace_root.is_none() {
            return col.child(muted_message("Open a project to browse files.", muted));
        }
        if self.tree.is_root_loading() && !self.tree.has_loaded("") {
            return col.child(tree_status("Loading files\u{2026}", 4.0, muted));
        }
        if let Some(err) = self.tree_error.as_ref().or(self.search_error.as_ref()) {
            // `FileBrowserPanel`: `p-4 text-left text-xs text-destructive`, click to retry.
            return col.child(
                div()
                    .id("files-tree-error")
                    .a11y_button("panel.files.retry", "Retry loading files")
                    .p(px(16.0))
                    .cursor_pointer()
                    .text_size(px(STATUS_TEXT_PX))
                    .line_height(px(STATUS_LINE_HEIGHT_PX))
                    .text_color(to_hsla(self.tokens.destructive_foreground))
                    .on_click(cx.listener(|this, _, _, cx| this.refresh_files(cx)))
                    .child(format!("{err} Click to retry.")),
            );
        }

        let rows = self.tree.visible_rows();
        if rows.is_empty() {
            return col.child(if self.tree.query().trim().is_empty() {
                muted_message("This folder is empty.", muted).into_any_element()
            } else if self.search_pending {
                tree_status("Loading files\u{2026}", 4.0, muted).into_any_element()
            } else {
                tree_status("No matching files.", 16.0, muted).into_any_element()
            });
        }
        if self.search_truncated && !self.search_pending && !self.tree.query().trim().is_empty() {
            col = col.child(tree_status(
                "More matches available. Refine your search.",
                4.0,
                muted,
            ));
        }

        let selected = self.tree.selected();
        for row in rows {
            let is_dir = row.kind == ProjectEntryKind::Directory;
            let is_selected = selected == Some(row.path.as_str());
            // Row margin-x is 2px (6+2 = 8px from panel edge), padding-x is 8px (8+8 = 16px to icon).
            let indent_px = 8.0 + (row.depth as f32) * 14.0;
            let row_path = row.path.clone();
            let text_color = if row.ignored && !is_selected {
                muted
            } else {
                fg
            };
            let resolved_icon = crate::file_icons::file_icon(&row.name);
            let icon_color = resolved_icon
                .color
                .map(|c| to_hsla(c.for_appearance(self.tokens.appearance)))
                .unwrap_or(muted);

            let item = h_flex()
                .id(SharedString::from(format!("tree-row-{}", row.path)))
                .a11y_button(format!("panel.files.row.{}", row.path), row.name.clone())
                .mx(px(2.0))
                .h(px(TREE_ROW_HEIGHT_PX))
                .pl(px(indent_px))
                .pr(px(8.0))
                .gap(px(6.0))
                .items_center()
                .rounded(px(TREE_ROW_RADIUS_PX))
                .cursor_pointer()
                .when(is_selected, |el| el.bg(selected_bg))
                .when(!is_selected, |el| el.hover(move |s| s.bg(hover_bg)))
                .on_drag(
                    file_path::FileMentionDrag {
                        path: row_path.clone(),
                    },
                    {
                        let (fg, bg) = (
                            to_hsla(self.tokens.foreground),
                            to_hsla(self.tokens.shell_highlight),
                        );
                        move |drag, _, _, cx| {
                            let label = drag
                                .path
                                .rsplit('/')
                                .next()
                                .unwrap_or(&drag.path)
                                .to_owned();
                            cx.new(|_| MentionDragPreview { label, fg, bg })
                        }
                    },
                )
                .on_mouse_down(
                    MouseButton::Right,
                    cx.listener({
                        let path = row_path.clone();
                        move |this, event: &MouseDownEvent, _, cx| {
                            cx.stop_propagation();
                            this.row_menu = Some(RowMenu {
                                path: path.clone(),
                                position: event.position,
                            });
                            cx.notify();
                        }
                    }),
                )
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |this, _, _, cx| {
                        if is_dir {
                            if this.tree.toggle_directory(&row_path) {
                                this.load_directory(row_path.clone(), cx);
                            } else {
                                cx.notify();
                            }
                        } else {
                            this.tree.select(Some(row_path.clone()));
                            cx.emit(FilesEvent::OpenFile(row_path.clone()));
                            cx.notify();
                        }
                    }),
                )
                .child(if is_dir {
                    let chevron = if row.expanded {
                        "superhero/chevron-down.svg"
                    } else {
                        "superhero/chevron-right.svg"
                    };
                    div()
                        .w(px(12.0))
                        .flex()
                        .flex_shrink_0()
                        .items_center()
                        .justify_center()
                        .child(superhero_icon(chevron, 12.0, muted))
                } else {
                    div().w(px(12.0)).flex_shrink_0()
                })
                .when(!is_dir, |el| {
                    el.child(superhero_icon(resolved_icon.asset, 15.0, icon_color))
                })
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(px(UI_TEXT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .text_color(text_color)
                        .child(row.name),
                );
            col = col.child(item);
        }

        col
    }

    fn render_preview_column(
        &mut self,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> impl IntoElement {
        let muted = to_hsla(self.tokens.muted_foreground);
        let body = v_flex().id("files-editor-host").flex_1().min_h_0().w_full();
        let container = v_flex()
            .id("files-preview-scroll")
            .a11y_group("panel.files.preview", "File preview")
            .flex_1()
            .min_h_0()
            .w_full()
            .overflow_y_scroll()
            .track_scroll(&self.preview_scroll);

        match &self.preview {
            PreviewState::Empty => container
                .items_center()
                .justify_center()
                .child(muted_message("Select a file to preview.", muted)),
            PreviewState::Loading(_) if !self.loading_hint => container,
            PreviewState::Loading(path) => container
                .items_center()
                .justify_center()
                .child(muted_message(&format!("Loading {path}…"), muted)),
            PreviewState::Error { path, message } => container
                .items_center()
                .justify_center()
                .px(px(16.0))
                .child(muted_message(
                    &format!("Could not read {path}: {message}"),
                    muted,
                )),
            PreviewState::Image { image, .. } => container
                .items_center()
                .justify_center()
                .p(px(12.0))
                .child(
                    img(ImageSource::Image(image.clone()))
                        .object_fit(ObjectFit::Contain)
                        .max_w_full()
                        .max_h_full(),
                ),
            PreviewState::Document { .. } => container
                .items_center()
                .justify_center()
                .px(px(16.0))
                .child(muted_message(
                    "PDFs open in the Browser panel. Use \u{201c}Open file in browser\u{201d} above.",
                    muted,
                )),
            PreviewState::Loaded {
                path,
                raw_contents,
                ..
            } if self.render_preview && file_kind::preview_kind(path).has_rendered_view() => {
                match file_kind::preview_kind(path) {
                    PreviewKind::Delimited { delimiter } => self.render_table(
                        container,
                        &file_kind::parse_delimited(raw_contents, delimiter, file_kind::MAX_TABLE_ROWS),
                        cx,
                    ),
                    _ => container.px(px(16.0)).py(px(12.0)).child(render_markdown(
                        &format!("file-preview-{path}"),
                        raw_contents,
                        &self.tokens,
                        &MarkdownOptions::default(),
                    )),
                }
            }
            PreviewState::Loaded {
                path,
                raw_contents,
                truncated,
            } => {
                let prefs = crate::editor_settings::current(cx);
                let family = crate::editor_settings::family(cx);
                let font_id = cx.text_system().resolve_font(&gpui_kit::font(family.clone()));
                let size = px(prefs.font_size);
                #[cfg(feature = "zed-files")]
                if super::zed_preview::enabled() && path.ends_with(".php") && !*truncated {
                    let editor = self.zed.get_or_insert_with(|| {
                        let editor = super::zed_preview::open(raw_contents, self.word_wrap, window, cx);
                        self.editor_subscription = Some(cx.subscribe(
                            &editor,
                            |_, _, event: &zed_editor::EditorEvent, cx| {
                                if matches!(event, zed_editor::EditorEvent::SelectionsChanged { .. }) {
                                    cx.notify();
                                }
                            },
                        ));
                        editor
                    });
                    if self.pending_path.is_none() && let Some(reveal) = self.reveal.take() {
                        let result = editor.update(cx, |editor, cx| {
                            super::zed_preview::reveal(
                                editor, raw_contents, reveal.lines, reveal.excerpt.as_deref(), cx,
                            )
                        });
                        let _ = reveal.done.send(result);
                    }
                    let body = body.when_some(self.range_error.as_ref(), |body, error| body.child(muted_message(error, muted)));
                    let gutter_pad = cx.text_system().ch_width(font_id, size).unwrap_or_default();
                    return body.w_auto()
                        .py(px(FILE_TEXT_INSET_PX))
                        .ml(px(FILE_TEXT_INSET_PX) - gutter_pad)
                        .child(editor.clone())
                        .on_mouse_move(cx.listener(|panel, event: &gpui_kit::MouseMoveEvent, window, cx| {
                            if event.pressed_button.is_none() && (event.modifiers == gpui_kit::Modifiers::command() || event.modifiers == gpui_kit::Modifiers::default()) {
                                panel.zed_definition_at(event.position, false, window, cx);
                            } else {
                                panel.cancel_hover();
                            }
                        }))
                        .on_mouse_exit(cx.listener(|panel, _, _, _| panel.cancel_hover()))
                        .capture_any_mouse_down(cx.listener(|panel, event: &MouseDownEvent, _, _| {
                            panel.definition_press = (event.button == MouseButton::Left
                                && event.modifiers == gpui_kit::Modifiers::command()
                                && event.click_count == 1).then_some(event.position);
                        }))
                        .capture_any_mouse_up(cx.listener(|panel, event: &gpui_kit::MouseUpEvent, window, cx| {
                            if let Some(start) = panel.definition_press.take()
                                && event.button == MouseButton::Left
                                && event.modifiers == gpui_kit::Modifiers::command()
                                && (event.position - start).magnitude() <= 4.0
                            {
                                panel.zed_definition_at(event.position, true, window, cx);
                            }
                        }));
                }
                let editor = self.editor.get_or_insert_with(|| {
                    let language = (raw_contents.len() <= 512 * 1024)
                        .then(|| std::path::Path::new(path).extension()?.to_str())
                        .flatten()
                        .unwrap_or("text");
                    let panel = cx.entity().downgrade();
                    let editor = cx.new(|cx| {
                        let mut editor = EditorState::new(window, cx)
                            .language(language.to_owned())
                            .default_value(raw_contents.clone())
                            .soft_wrap(self.word_wrap)
                            .line_number(true);
                        if path.ends_with(".php")
                            && !*truncated
                            && let (Some(conn), Some(thread)) = (&self.connection, &self.thread)
                        {
                            super::files_definition::configure(
                                &mut editor,
                                conn.clone(),
                                thread.clone(),
                                path.clone(),
                                panel,
                            );
                        }
                        editor
                    });
                    self.editor_subscription = Some(cx.observe(&editor, |_, _, cx| cx.notify()));
                    editor
                });
                let mut body = body;
                if self.reveal.is_some() && editor.read(cx).line_height().is_none() {
                    let panel = cx.entity().downgrade();
                    window.on_next_frame(move |_, cx| {
                        let _ = panel.update(cx, |_, cx| cx.notify());
                    });
                } else if self.pending_path.is_none() && let Some(reveal) = self.reveal.take() {
                    let text = editor.read(cx).value();
                    let range = reveal.lines.bytes(&text).filter(|r| {
                        reveal.excerpt.as_ref().is_none_or(|excerpt| {
                            text.get(r.clone()).is_some_and(|actual| {
                                actual == excerpt
                                    || actual.replace("\r\n", "\n") == excerpt.replace("\r\n", "\n")
                            })
                        })
                    });
                    if let Some(range) = range {
                        self.highlight = Some(editor.update(cx, |e, cx| {
                            let row = e
                                .display_map()
                                .buffer_line_to_display_row(reveal.lines.start_line - 1);
                            let mut offset = e.scroll_offset();
                            if let Some(height) = e.line_height() {
                                offset.y = -height * row.saturating_sub(2) as f32;
                                e.set_scroll_offset(offset, cx);
                            }
                            e.create_range_decorations_collection(
                                vec![
                                    RangeDecoration::new(range)
                                        .with_style(RangeDecorationStyle::Fill),
                                ],
                                cx,
                            )
                        }));
                        let _ = reveal.done.send(Ok(()));
                    } else {
                        let message =
                            "The requested lines are missing or their contents have changed.";
                        self.range_error = Some(message.into());
                        let _ = reveal.done.send(Err(message.into()));
                    }
                }
                if let Some(error) = &self.range_error {
                    body = body.child(muted_message(error, muted));
                }
                if *truncated {
                    body = body.child(muted_message("File preview was truncated.", muted));
                }
                // Kit pads its gutter to three digits and starts it six pixels inside the input.
                let digits = editor.read(cx).text().lines_len().max(1).ilog10() + 1;
                let space = cx.text_system().advance(font_id, size, ' ').map(|s| s.width).unwrap_or_default();
                let gutter_pad = px(6.0) + space * 3u32.saturating_sub(digits) as f32;
                body.w_auto().ml(px(FILE_TEXT_INSET_PX) - gutter_pad).child(
                    Editor::new(editor)
                        .font_family(family)
                        .text_size(px(prefs.font_size))
                        .line_height(gpui_kit::relative(prefs.line_height))
                        .appearance(false)
                        .bordered(false)
                        .readonly(true)
                        .size_full(),
                )
            }
        }
    }
}

impl FilesPanel {
    /// Runs a row-menu action on the workspace-relative `path`.
    fn run_row_action(&mut self, action: RowAction, path: &str, cx: &mut Context<'_, Self>) {
        self.row_menu = None;
        let root = self.workspace_root.clone().unwrap_or_default();
        let absolute = file_path::absolute_path(&root, path);
        let spawn = |args: &[&str]| {
            if let Err(error) = std::process::Command::new("open").args(args).spawn() {
                eprintln!("open {args:?}: {error}");
            }
        };
        match action {
            RowAction::Open => spawn(&[&absolute]),
            RowAction::Reveal => spawn(&["-R", &absolute]),
            RowAction::OpenWith(editor) => {
                self.preferred_editor = Some(editor);
                match editor.app_name() {
                    Some(app) => spawn(&["-a", app, &absolute]),
                    None => spawn(&[&absolute]),
                }
            }
            RowAction::CopyRelativePath => {
                cx.write_to_clipboard(ClipboardItem::new_string(path.to_owned()));
            }
            RowAction::CopyFullPath => cx.write_to_clipboard(ClipboardItem::new_string(absolute)),
            RowAction::CopyMention => {
                cx.write_to_clipboard(ClipboardItem::new_string(file_path::mention(path)));
            }
            RowAction::AddToChat => cx.emit(FilesEvent::AddToChat(file_path::mention(path))),
        }
        cx.notify();
    }

    /// The context menu of a tree row, or the preview's `Open in` menu: Open, Reveal in Finder
    /// and Open with an editor (these need the file on this Mac), then the copy actions.
    fn render_row_menu(&self, cx: &mut Context<'_, Self>) -> Option<gpui_kit::AnyElement> {
        let menu = self.row_menu.as_ref()?;
        let tokens = &self.tokens;
        let fg = to_hsla(tokens.popover_foreground);
        let muted = to_hsla(tokens.muted_foreground);
        let hover = crate::sidebar::thread_menu::MenuHighlight::new(tokens);
        let divider = to_hsla(tokens.shell_divider);
        let local = self.workspace_root.as_deref().is_some_and(|root| {
            std::path::Path::new(&file_path::absolute_path(root, &menu.path)).exists()
        });

        let item = |id: &str,
                    label: String,
                    icon: &'static str,
                    action: RowAction,
                    cx: &mut Context<'_, Self>| {
            let path = menu.path.clone();
            let group = SharedString::from(format!("files-row-menu-{id}"));
            h_flex()
                .id(group.clone())
                .group(group.clone())
                .a11y_button(format!("panel.files.row-menu.{id}"), label.clone())
                .items_center()
                .gap(px(8.0))
                .min_h(px(28.0))
                .px(px(8.0))
                .rounded(px(8.0))
                .cursor_pointer()
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(fg)
                .hover(move |s| hover.hover_style(s))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.run_row_action(action, &path, cx);
                }))
                .child(
                    superhero_icon(icon, 14.0, muted)
                        .group_hover(group, move |s| s.text_color(hover.fg)),
                )
                .child(div().flex_1().min_w_0().truncate().child(label))
        };
        let separator = || div().my(px(3.0)).h(px(1.0)).bg(divider);

        let mut list = v_flex().gap(px(1.0));
        if local {
            list = list
                .child(item(
                    "open",
                    "Open".to_owned(),
                    "superhero/external-link.svg",
                    RowAction::Open,
                    cx,
                ))
                .child(item(
                    "reveal",
                    "Reveal in Finder".to_owned(),
                    "superhero/folder.svg",
                    RowAction::Reveal,
                    cx,
                ));
            for editor in EditorTarget::ALL {
                if editor.app_name().is_none() {
                    continue;
                }
                list = list.child(item(
                    &format!(
                        "open-with-{}",
                        editor.label().to_ascii_lowercase().replace(' ', "-")
                    ),
                    format!("Open with {}", editor.label()),
                    "superhero/code.svg",
                    RowAction::OpenWith(editor),
                    cx,
                ));
            }
            list = list.child(separator());
        }
        list = list
            .child(item(
                "copy-relative",
                "Copy relative path".to_owned(),
                "superhero/copy.svg",
                RowAction::CopyRelativePath,
                cx,
            ))
            .child(item(
                "copy-full",
                "Copy full path".to_owned(),
                "superhero/copy.svg",
                RowAction::CopyFullPath,
                cx,
            ))
            .child(item(
                "copy-mention",
                "Copy mention".to_owned(),
                "superhero/copy.svg",
                RowAction::CopyMention,
                cx,
            ))
            .child(item(
                "add-to-chat",
                "Add to chat".to_owned(),
                "superhero/comment-text.svg",
                RowAction::AddToChat,
                cx,
            ));

        let card = v_flex()
            .id("files-row-menu")
            .a11y(gpui_kit::Role::Menu, "panel.files.row-menu", "File actions")
            .w(px(220.0))
            .p(px(4.0))
            .rounded(px(12.0))
            .bg(to_hsla(tokens.popover))
            .border_1()
            .border_color(to_hsla(tokens.foreground.with_alpha(0.08)))
            .shadow(vec![super::header::dropdown_glass_shadow(tokens)])
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                this.row_menu = None;
                cx.notify();
            }))
            .child(list);
        Some(
            deferred(anchored().position(menu.position).child(card))
                .with_priority(7)
                .into_any_element(),
        )
    }
}

/// The GPUI image format for a MIME type the file preview offers.
fn image_format(mime: &str) -> Option<ImageFormat> {
    match mime {
        "image/png" => Some(ImageFormat::Png),
        "image/jpeg" => Some(ImageFormat::Jpeg),
        "image/gif" => Some(ImageFormat::Gif),
        "image/webp" => Some(ImageFormat::Webp),
        "image/svg+xml" => Some(ImageFormat::Svg),
        "image/bmp" => Some(ImageFormat::Bmp),
        _ => None,
    }
}

impl FilesPanel {
    /// The table preview (`DelimitedTablePreview`): a header row over the data rows, in a grid
    /// that scrolls sideways when it is wider than the panel.
    fn render_table(
        &self,
        container: gpui_kit::Stateful<gpui_kit::Div>,
        rows: &[Vec<String>],
        cx: &App,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        let fg = to_hsla(self.tokens.foreground);
        let muted = to_hsla(self.tokens.muted_foreground);
        let divider = to_hsla(self.tokens.shell_divider);
        let head_bg = to_hsla(self.tokens.shell_highlight);
        let mono = mono_font_family(cx);
        let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
        if columns == 0 {
            return container
                .items_center()
                .justify_center()
                .child(muted_message("This file is empty.", muted));
        }
        let cell = |text: &str, header: bool| {
            div()
                .w(px(160.0))
                .flex_shrink_0()
                .px(px(10.0))
                .py(px(4.0))
                .truncate()
                .border_r_1()
                .border_color(divider)
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .when(header, |el| el.font_weight(gpui_kit::FontWeight::MEDIUM))
                .text_color(fg)
                .child(text.to_owned())
        };
        let mut grid = v_flex().min_w_full();
        for (index, row) in rows.iter().enumerate() {
            let header = index == 0;
            let mut line = h_flex()
                .border_b_1()
                .border_color(divider)
                .when(header, |el| el.bg(head_bg))
                .when(!header, |el| el.font_family(mono.clone()));
            for column in 0..columns {
                line = line.child(cell(row.get(column).map_or("", String::as_str), header));
            }
            grid = grid.child(line);
        }
        let note = (rows.len() >= file_kind::MAX_TABLE_ROWS).then(|| {
            div()
                .px(px(10.0))
                .py(px(6.0))
                .text_size(px(STATUS_TEXT_PX))
                .line_height(px(STATUS_LINE_HEIGHT_PX))
                .text_color(muted)
                .child(format!(
                    "Showing the first {} rows.",
                    file_kind::MAX_TABLE_ROWS
                ))
        });
        container.overflow_x_scroll().child(grid).children(note)
    }
}

impl Render for FilesPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        if self.showing_preview {
            return v_flex()
                .size_full()
                .child(self.render_preview_subheader(cx))
                .child(
                    v_flex()
                        .relative()
                        .flex_1()
                        .min_h_0()
                        .w_full()
                        .overflow_hidden()
                        .child(self.render_preview_column(window, cx))
                        .children(self.render_preview_actions(cx)),
                )
                .children(self.render_row_menu(cx))
                .into_any_element();
        }
        v_flex()
            .size_full()
            .child(self.render_tree_toolbar(cx))
            .child(self.render_tree_column(cx))
            .children(self.render_row_menu(cx))
            .into_any_element()
    }
}

impl FilesPanel {
    /// The breadcrumb trail (`FileBreadcrumbs`): the project, each folder and the file. A folder
    /// crumb reveals that folder in the tree; the chevron after it opens its contents menu.
    fn render_breadcrumbs(
        &self,
        path: &str,
        fg: gpui_kit::Hsla,
        muted: gpui_kit::Hsla,
        cx: &mut Context<'_, Self>,
    ) -> impl IntoElement {
        let hover = to_hsla(self.tokens.shell_highlight);
        let project = self.project_name();
        let crumbs = file_path::breadcrumbs(&project, path);
        let last = crumbs.len().saturating_sub(1);
        let mut row = h_flex()
            .id("files-breadcrumbs")
            .a11y_group("panel.files.breadcrumbs", "File path")
            .w_full()
            .items_center()
            .overflow_x_scroll()
            .track_scroll(&self.crumb_scroll)
            .text_size(px(BREADCRUMB_TEXT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX));
        // A long trail scrolls, kept at its end where the file is; a new path scrolls to its end.
        if self.crumbs_scrolled_for.borrow().as_deref() != Some(path) {
            self.crumb_scroll.scroll_to_item(last);
            *self.crumbs_scrolled_for.borrow_mut() = Some(path.to_owned());
        }
        for (index, crumb) in crumbs.into_iter().enumerate() {
            let Crumb {
                label,
                path: crumb_path,
                is_file,
            } = crumb;
            let tooltip = if crumb_path.is_empty() {
                project.clone()
            } else {
                crumb_path.clone()
            };
            let slug = format!("{index}");
            if is_file {
                row = row.child(
                    div()
                        .id(SharedString::from(format!("files-crumb-{slug}")))
                        .a11y_group(format!("panel.files.crumb.{slug}"), label.clone())
                        .flex_shrink_0()
                        .max_w(px(160.0))
                        .truncate()
                        .px(px(CRUMB_PAD_PX))
                        .font_weight(gpui_kit::FontWeight::MEDIUM)
                        .text_color(fg)
                        .conn_tooltip(tooltip, &self.tokens)
                        .child(label.clone()),
                );
            } else {
                let reveal_path = crumb_path.clone();
                row = row.child(
                    div()
                        .id(SharedString::from(format!("files-crumb-{slug}")))
                        .a11y_button(format!("panel.files.crumb.{slug}"), label.clone())
                        .flex_shrink_0()
                        .max_w(px(160.0))
                        .truncate()
                        .rounded(px(4.0))
                        .px(px(CRUMB_PAD_PX))
                        .cursor_pointer()
                        .text_color(muted)
                        .hover(move |s| s.bg(hover).text_color(fg))
                        .conn_tooltip(tooltip, &self.tokens)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.reveal_folder(reveal_path.clone(), cx);
                        }))
                        .child(label.clone()),
                );
            }
            if index < last {
                let menu_root = crumb_path;
                let open = self
                    .crumb_menu
                    .as_ref()
                    .is_some_and(|m| m.root == menu_root);
                row = row.child(
                    div()
                        .id(SharedString::from(format!("files-crumb-menu-{slug}")))
                        .a11y_button(
                            format!("panel.files.crumb-menu.{slug}"),
                            format!("Browse {label}"),
                        )
                        .flex_shrink_0()
                        .mx(px(2.0))
                        .w(px(16.0))
                        .h(px(20.0))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(4.0))
                        .cursor_pointer()
                        .when(open, |el| el.bg(hover))
                        .hover(move |s| s.bg(hover))
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(move |this, event: &MouseDownEvent, _, cx| {
                                cx.stop_propagation();
                                this.open_crumb_menu(menu_root.clone(), event.position, cx);
                            }),
                        )
                        .child(superhero_icon(
                            "superhero/chevron-right.svg",
                            12.0,
                            muted.opacity(0.6),
                        )),
                );
            }
        }
        // Fades at the edges that have more crumbs beyond them (`FileBreadcrumbs` mask).
        let offset = f32::from(self.crumb_scroll.offset().x);
        let reach = f32::from(self.crumb_scroll.max_offset().x);
        let card = to_hsla(self.tokens.shell_card);
        let fade = |left: bool| {
            let (from, to) = (card, card.opacity(0.0));
            let el = div().absolute().top_0().bottom_0().w(px(CRUMB_FADE_PX));
            if left {
                el.left_0().bg(gpui_kit::linear_gradient(
                    90.0,
                    gpui_kit::linear_color_stop(to, 0.0),
                    gpui_kit::linear_color_stop(from, 1.0),
                ))
            } else {
                el.right_0().bg(gpui_kit::linear_gradient(
                    90.0,
                    gpui_kit::linear_color_stop(from, 0.0),
                    gpui_kit::linear_color_stop(to, 1.0),
                ))
            }
        };
        div()
            .relative()
            .flex_1()
            .min_w_0()
            .child(row)
            .when(offset < -0.5, |el| el.child(fade(true)))
            .when(reach + offset > 0.5, |el| el.child(fade(false)))
    }

    /// The folder contents menu of a breadcrumb (`BreadcrumbMenuContent`): Back to the parent,
    /// then the folder's folders and files; a file opens, a folder lists its own contents.
    fn render_crumb_menu(
        &self,
        current_path: &str,
        cx: &mut Context<'_, Self>,
    ) -> Option<gpui_kit::AnyElement> {
        let menu = self.crumb_menu.as_ref()?;
        let tokens = &self.tokens;
        let fg = to_hsla(tokens.popover_foreground);
        let muted = to_hsla(tokens.muted_foreground);
        let hover = crate::sidebar::thread_menu::MenuHighlight::new(tokens);
        let project = self.project_name();

        let row = |id: String, ax: String, icon: &'static str, label: String| {
            let group = SharedString::from(id);
            h_flex()
                .id(group.clone())
                .group(group.clone())
                .a11y_button(ax, label.clone())
                .items_center()
                .gap(px(8.0))
                .min_h(px(28.0))
                .px(px(8.0))
                .rounded(px(8.0))
                .cursor_pointer()
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(fg)
                .hover(move |s| hover.hover_style(s))
                .child(
                    superhero_icon(icon, 14.0, muted)
                        .group_hover(group, move |s| s.text_color(hover.fg)),
                )
                .child(div().flex_1().min_w_0().truncate().child(label))
        };
        let status = |text: &str| {
            div()
                .px(px(8.0))
                .py(px(6.0))
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(muted)
                .child(text.to_owned())
        };

        let mut list = v_flex().gap(px(1.0));
        let parent = file_path::breadcrumb_parent(&menu.directory).filter(|parent| {
            menu.directory != menu.root
                && (menu.root.is_empty()
                    || *parent == menu.root
                    || parent.starts_with(&format!("{}/", menu.root)))
        });
        if let Some(parent) = parent {
            let label = format!("Back to {}", file_path::path_label(&parent, &project));
            list = list.child(
                row(
                    "files-crumb-menu-back".to_owned(),
                    "panel.files.crumb-menu.back".to_owned(),
                    "superhero/arrow-left.svg",
                    label,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.load_crumb_menu(parent.clone(), cx);
                })),
            );
            list = list.child(
                div()
                    .my(px(3.0))
                    .h(px(1.0))
                    .bg(to_hsla(tokens.shell_divider)),
            );
        }

        match &menu.load {
            MenuLoad::Loading => list = list.child(status("Loading folder\u{2026}")),
            MenuLoad::Failed => {
                let directory = menu.directory.clone();
                list = list.child(
                    row(
                        "files-crumb-menu-retry".to_owned(),
                        "panel.files.crumb-menu.retry".to_owned(),
                        "superhero/refresh.svg",
                        "Retry loading folder".to_owned(),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.load_crumb_menu(directory.clone(), cx);
                    })),
                );
            }
            MenuLoad::Ready(entries) => {
                let children = file_path::breadcrumb_children(entries, &menu.directory);
                if children.is_empty() {
                    list = list.child(status("This folder is empty."));
                }
                for child in children {
                    let is_dir = child.kind == ProjectEntryKind::Directory;
                    let current = !is_dir && child.path == current_path;
                    let icon = if is_dir {
                        "superhero/folder.svg"
                    } else {
                        crate::file_icons::file_icon(&child.label).asset
                    };
                    let target = child.path.clone();
                    let mut item = row(
                        format!("files-crumb-menu-{}", child.path),
                        format!("panel.files.crumb-menu.{}", child.path),
                        icon,
                        child.label.clone(),
                    )
                    .when(child.ignored, |el| el.text_color(muted))
                    .when(current, |el| el.bg(to_hsla(tokens.shell_highlight)))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if is_dir {
                            this.load_crumb_menu(target.clone(), cx);
                        } else {
                            this.crumb_menu = None;
                            cx.emit(FilesEvent::OpenFile(target.clone()));
                            cx.notify();
                        }
                    }));
                    if is_dir {
                        item =
                            item.child(superhero_icon("superhero/chevron-right.svg", 12.0, muted));
                    }
                    list = list.child(item);
                }
            }
        }

        let card = v_flex()
            .id("files-crumb-menu")
            .a11y(
                gpui_kit::Role::Menu,
                "panel.files.crumb-menu",
                "Folder contents",
            )
            .w(px(260.0))
            .max_h(px(360.0))
            .overflow_y_scroll()
            .p(px(4.0))
            .rounded(px(12.0))
            .bg(to_hsla(tokens.popover))
            .border_1()
            .border_color(to_hsla(tokens.foreground.with_alpha(0.08)))
            .shadow(vec![super::header::dropdown_glass_shadow(tokens)])
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                this.crumb_menu = None;
                cx.notify();
            }))
            .child(list);
        Some(
            deferred(
                anchored()
                    .position(menu.position + gpui_kit::point(px(-8.0), px(14.0)))
                    .child(card),
            )
            .with_priority(7)
            .into_any_element(),
        )
    }
}

/// `text-xs` (12px / 16px), as the tree's status lines in `FileBrowserPanel`.
const STATUS_TEXT_PX: f32 = 12.0;
const STATUS_LINE_HEIGHT_PX: f32 = 16.0;

/// A tree status line: `px-3 text-xs text-muted-foreground`, `py-1` while loading and `py-4`
/// when nothing matches.
fn tree_status(text: &str, pad_y: f32, color: gpui_kit::Hsla) -> impl IntoElement {
    div()
        .px(px(12.0))
        .py(px(pad_y))
        .text_size(px(STATUS_TEXT_PX))
        .line_height(px(STATUS_LINE_HEIGHT_PX))
        .text_color(color)
        .child(text.to_owned())
}

fn muted_message(text: &str, color: gpui_kit::Hsla) -> impl IntoElement {
    div()
        .px(px(12.0))
        .py(px(10.0))
        .text_size(px(UI_TEXT_PX))
        .line_height(px(UI_LINE_HEIGHT_PX))
        .text_color(color)
        .child(text.to_owned())
}

fn mono_font_family(cx: &App) -> SharedString {
    use gpui_kit::component::ActiveTheme as _;
    cx.theme().mono_font_family.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::TestAppContext;
    use gpui_kit::test::TestWindowExt as _;

    #[cfg(feature = "zed-files")]
    #[gpui_kit::test]
    fn php_preview_opens_in_zed_and_reveals_the_requested_line(cx: &mut TestAppContext) {
        if !crate::panels::zed_preview::enabled() {
            return;
        }
        let (done, mut reply) = tokio::sync::oneshot::channel();
        let (window, files) = cx.update(|cx| {
            gpui_kit::init(cx);
            crate::panels::zed_preview::init(cx);
            let tokens = Tokens::derive(&conn_theme::theme_by_id("dark-ocean").unwrap());
            gpui_kit::open_window(Default::default(), cx, |window, cx| {
                cx.new(|cx| {
                    let mut files = FilesPanel::new(tokens, None, window, cx);
                    files.showing_preview = true;
                    files.preview = PreviewState::Loaded {
                        path: "routes/web.php".into(),
                        raw_contents: "<?php\nclass Example {}\n".into(),
                        truncated: false,
                    };
                    files.reveal = Some(PendingReveal {
                        lines: SourceLines {
                            start_line: 2,
                            end_line: 2,
                        },
                        excerpt: Some("class Example {}".into()),
                        done,
                    });
                    files
                })
            })
            .unwrap()
        });
        cx.update_window(window, |_, window, cx| {
            window.render_frame(cx);
            assert!(files.read(cx).zed.is_some());
            assert!(reply.try_recv().unwrap().is_ok());
            assert!(files.read(cx).selected_source(cx).is_none());
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn walkthrough_highlight_preserves_selection_and_rejects_stale_lines(cx: &mut TestAppContext) {
        let (window, files) = cx.update(|cx| {
            gpui_kit::init(cx);
            let tokens = Tokens::derive(&conn_theme::theme_by_id("dark-ocean").unwrap());
            gpui_kit::open_window(Default::default(), cx, |window, cx| {
                cx.new(|cx| {
                    let mut files = FilesPanel::new(tokens, None, window, cx);
                    files.showing_preview = true;
                    files.preview = PreviewState::Loaded {
                        path: "docs/first.txt".into(),
                        raw_contents: "first\nsecond\nthird".into(),
                        truncated: false,
                    };
                    files
                })
            })
            .unwrap()
        });
        cx.update_window(window, |_, window, cx| {
            window.render_frame(cx);
            assert!(files.read(cx).selected_source(cx).is_none());
            let editor = files.read(cx).editor.clone().unwrap();
            editor.update(cx, |e, cx| e.set_selected_range(6..12, cx));
            for (excerpt, matches) in [("third", true), ("changed", false)] {
                let (done, mut reply) = tokio::sync::oneshot::channel();
                files.update(cx, |p, cx| {
                    p.reveal = Some(PendingReveal {
                        lines: SourceLines {
                            start_line: 3,
                            end_line: 3,
                        },
                        excerpt: Some(excerpt.into()),
                        done,
                    });
                    cx.notify();
                });
                window.render_frame(cx);
                assert_eq!(reply.try_recv().unwrap().is_ok(), matches);
                assert_eq!(files.read(cx).selected_source(cx).unwrap().text, "second");
            }
            assert_eq!(
                files.read(cx).highlight.as_ref().unwrap().get_ranges(cx),
                vec![13..18]
            );
            let (done, mut reply) = tokio::sync::oneshot::channel();
            files.update(cx, |p, cx| {
                p.pending_path = Some("docs/other.txt".into());
                p.reveal = Some(PendingReveal {
                    lines: SourceLines {
                        start_line: 2,
                        end_line: 2,
                    },
                    excerpt: Some("new definition".into()),
                    done,
                });
                cx.notify();
            });
            window.render_frame(cx);
            assert!(matches!(
                reply.try_recv(),
                Err(tokio::sync::oneshot::error::TryRecvError::Empty)
            ));
            assert_eq!(files.read(cx).held_file(), Some("docs/first.txt"));
            assert_eq!(
                files.read(cx).selected_source(cx).unwrap().path,
                "docs/first.txt"
            );
            files.update(cx, |p, cx| {
                let path = p.pending_path.take().unwrap();
                p.present(
                    PreviewState::Loaded {
                        path,
                        raw_contents: "first\nnew definition".into(),
                        truncated: false,
                    },
                    cx,
                );
            });
            window.render_frame(cx);
            let destination = files.read(cx).editor.as_ref().unwrap().read(cx);
            assert!(destination.line_height().is_some());
            window.render_frame(cx);
            assert!(reply.try_recv().unwrap().is_ok());
            files.update(cx, |p, cx| p.reset_preview(cx));
            assert!(files.read(cx).selected_source(cx).is_none());
        })
        .unwrap();
    }
}
