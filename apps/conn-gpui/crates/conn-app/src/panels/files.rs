//! Files right-panel surfaces, as Conn's `FileBrowserPanel` and `FilePreviewPanel`: the Files
//! tab is one full-width Pierre-themed lazy tree (`projects.listEntries`) under a soft search
//! field and `ToolbarGroup`; a file opens as its own tab showing a syntect-highlighted
//! read-only preview (`projects.readFile`) under a breadcrumb subheader.

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
use super::highlight::{HighlightSpan, highlight_lines};
use super::tree::FileTreeState;
use crate::header::details_card::EditorTarget;

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
        lines: Vec<Vec<HighlightSpan>>,
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

/// What the Files surfaces ask of the right panel.
#[derive(Clone, Debug)]
pub(crate) enum FilesEvent {
    /// A file row was clicked: open the file as its own tab.
    OpenFile(String),
    /// A folder crumb was clicked: show the Files tree with that folder expanded and selected.
    RevealFolder,
    /// "Add to chat": put this mention at the end of the composer's draft.
    AddToChat(String),
    /// The Browser panel should show this URL (an HTML or PDF file's signed address).
    OpenInBrowser(String),
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
    tree: FileTreeState,
    tree_error: Option<String>,
    preview: PreviewState,
    word_wrap: bool,
    /// The Copy button shows a check for a moment after it copies (`useCopyToClipboard`).
    copied: bool,
    _copied_reset: Option<Task<()>>,
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
            tree: FileTreeState::default(),
            tree_error: None,
            preview: PreviewState::Empty,
            word_wrap: false,
            copied: false,
            _copied_reset: None,
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
    pub(crate) fn set_thread(&mut self, thread_id: Option<String>) {
        self.thread_id = thread_id;
    }

    pub(crate) fn set_connection(
        &mut self,
        connection: Option<Connection>,
        cx: &mut Context<'_, Self>,
    ) {
        self.connection = connection;
        self.context_generation = self.context_generation.wrapping_add(1);
        self.preview_generation = self.preview_generation.wrapping_add(1);
        self.tree.clear();
        self.tree_error = None;
        self.preview = PreviewState::Empty;
        cx.notify();
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens;
        if let PreviewState::Loaded {
            path,
            raw_contents,
            lines,
            ..
        } = &mut self.preview
        {
            *lines = highlight_lines(path, raw_contents, &self.tokens);
        }
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
        self.preview_generation = self.preview_generation.wrapping_add(1);
        self.tree.clear();
        self.tree_error = None;
        self.preview = PreviewState::Empty;
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
        let PreviewState::Loaded { lines, .. } = &self.preview else {
            return;
        };
        let line_count = lines.len().max(1);
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
        self.showing_preview = true;
        let current = match &self.preview {
            PreviewState::Loaded { path, .. }
            | PreviewState::Loading(path)
            | PreviewState::Image { path, .. }
            | PreviewState::Document { path }
            | PreviewState::Error { path, .. } => Some(path.as_str()),
            PreviewState::Empty => None,
        };
        if current != Some(path.as_str()) {
            self.open_file(path, cx);
        } else {
            cx.notify();
        }
    }

    fn open_file(&mut self, path: String, cx: &mut Context<'_, Self>) {
        self.tree.select(Some(path.clone()));
        let (Some(conn), Some(cwd)) = (self.connection.clone(), self.workspace_root.clone()) else {
            self.preview = PreviewState::Error {
                path,
                message: "Not connected to server.".to_owned(),
            };
            cx.notify();
            return;
        };
        self.preview_generation = self.preview_generation.wrapping_add(1);
        let generation = self.preview_generation;
        let kind = file_kind::preview_kind(&path);
        self.render_preview = kind.rendered_by_default();
        if kind == PreviewKind::Pdf {
            // A PDF is not read here; the Browser panel's Chromium shows it.
            self.preview = PreviewState::Document { path };
            cx.notify();
            return;
        }
        self.preview = PreviewState::Loading(path.clone());
        cx.notify();

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
                match res {
                    Ok(result) => {
                        let lines = highlight_lines(&path, &result.contents, &panel.tokens);
                        panel.preview = PreviewState::Loaded {
                            path,
                            raw_contents: result.contents,
                            lines,
                            truncated: result.truncated,
                        };
                        panel.apply_pending_reveal(cx);
                    }
                    Err(err) => {
                        panel.preview = PreviewState::Error {
                            path,
                            message: err.to_string(),
                        };
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
            self.preview = PreviewState::Error {
                path,
                message: "Open a thread to preview images.".to_owned(),
            };
            cx.notify();
            return;
        };
        cx.spawn(async move |this, cx| {
            let res = conn.fetch_workspace_file_bytes(&thread_id, &path).await;
            let _ = this.update(cx, |panel, cx| {
                if panel.preview_generation != generation {
                    return;
                }
                panel.preview = match res {
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
                cx.notify();
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
        let control_bg = to_hsla(self.tokens.shell_control);
        let control_border = to_hsla(self.tokens.shell_divider_header);
        // Preview subheader: breadcrumb path (`text-sm`) + Copy/Wrap `ToolbarGroup` when a file is open.
        let active_path = match &self.preview {
            PreviewState::Loaded { path, .. }
            | PreviewState::Loading(path)
            | PreviewState::Image { path, .. }
            | PreviewState::Document { path }
            | PreviewState::Error { path, .. } => Some(path.as_str()),
            PreviewState::Empty => None,
        };

        // `FILE_SURFACE_SUBHEADER_CLASS` inline: `py-toolbar pr-toolbar pl-3.5`, transparent
        // bottom border.
        let mut preview_toolbar = h_flex()
            .w_full()
            .flex_shrink_0()
            .min_h(px(TOOLBAR_HEIGHT_PX + 2.0 * TOOLBAR_PAD_Y_PX + 1.0))
            .py(px(TOOLBAR_PAD_Y_PX))
            .pl(px(14.0))
            .pr(px(TOOLBAR_PAD_Y_PX))
            .border_b_1()
            .border_color(gpui_kit::transparent_black())
            .items_center()
            .justify_between()
            .gap(px(8.0));

        if let Some(path) = active_path {
            preview_toolbar = preview_toolbar
                .child(self.render_breadcrumbs(path, fg, muted, cx))
                .children(self.render_crumb_menu(path, cx));
            let kind = file_kind::preview_kind(path);
            let loaded = matches!(self.preview, PreviewState::Loaded { .. });
            let document = matches!(self.preview, PreviewState::Document { .. });
            let rendered = kind.has_rendered_view() && self.render_preview;
            let mut group = h_flex()
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
            if buttons > 0 {
                preview_toolbar = preview_toolbar.child(group);
            }
        }

        preview_toolbar
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

    fn render_preview_column(&self, cx: &App) -> impl IntoElement {
        let muted = to_hsla(self.tokens.muted_foreground);
        let gutter_fg = to_hsla(self.tokens.muted_foreground.with_alpha(0.65));
        let mono_font = mono_font_family(cx);

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
                lines, truncated, ..
            } => {
                let gutter_digits = lines.len().max(1).to_string().len().max(3);
                let gutter_width = (gutter_digits as f32) * 8.0 + 18.0;
                let mut body = container.pt(px(6.0)).pb(px(12.0)).px(px(12.0));

                if *truncated {
                    body = body.child(
                        div()
                            .mb(px(8.0))
                            .px(px(10.0))
                            .py(px(6.0))
                            .rounded(px(6.0))
                            .bg(to_hsla(self.tokens.warning.with_alpha(0.10)))
                            .text_size(px(UI_TEXT_PX))
                            .line_height(px(UI_LINE_HEIGHT_PX))
                            .text_color(to_hsla(self.tokens.warning))
                            .child("File preview was truncated."),
                    );
                }

                for (idx, spans) in lines.iter().enumerate() {
                    let line_no = idx + 1;
                    let mut code_row = h_flex()
                        .flex_1()
                        .min_w_0()
                        .font_family(mono_font.clone())
                        .text_size(px(UI_TEXT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .when(!self.word_wrap, |el| {
                            el.overflow_hidden().whitespace_nowrap()
                        });

                    if spans.is_empty() {
                        code_row = code_row.child(" ");
                    } else {
                        for span in spans {
                            let mut el = div()
                                .text_color(to_hsla(span.color))
                                .child(span.text.clone());
                            if span.bold {
                                el = el.font_weight(gpui_kit::FontWeight::BOLD);
                            }
                            if span.italic {
                                el = el.italic();
                            }
                            code_row = code_row.child(el);
                        }
                    }

                    let flashing = self.revealed_line == Some(line_no);
                    body = body.child(
                        h_flex()
                            .w_full()
                            .items_start()
                            .when(flashing, |el| {
                                el.bg(to_hsla(self.tokens.primary.with_alpha(0.16)))
                            })
                            .child(
                                div()
                                    .w(px(gutter_width))
                                    .flex_shrink_0()
                                    .pr(px(14.0))
                                    .text_right()
                                    .font_family(mono_font.clone())
                                    .text_size(px(UI_TEXT_PX))
                                    .line_height(px(UI_LINE_HEIGHT_PX))
                                    .text_color(gutter_fg)
                                    .child(line_no.to_string()),
                            )
                            .child(code_row),
                    );
                }
                body
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
        let hover = to_hsla(tokens.shell_highlight);
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
            h_flex()
                .id(SharedString::from(format!("files-row-menu-{id}")))
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
                .hover(move |s| s.bg(hover))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.run_row_action(action, &path, cx);
                }))
                .child(superhero_icon(icon, 14.0, muted))
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
    fn render(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        if self.showing_preview {
            return v_flex()
                .size_full()
                .child(self.render_preview_subheader(cx))
                .child(self.render_preview_column(cx))
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
                        .px(px(2.0))
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
                        .px(px(2.0))
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
        let hover = to_hsla(tokens.shell_highlight);
        let project = self.project_name();

        let row = |id: String, ax: String, icon: &'static str, label: String| {
            h_flex()
                .id(SharedString::from(id))
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
                .hover(move |s| s.bg(hover))
                .child(superhero_icon(icon, 14.0, muted))
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
                    .when(current, |el| el.bg(hover))
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
