//! Files right-panel surfaces, as Conn's `FileBrowserPanel` and `FilePreviewPanel`: the Files
//! tab is one full-width Pierre-themed lazy tree (`projects.listEntries`) under a soft search
//! field and `ToolbarGroup`; a file opens as its own tab showing a syntect-highlighted
//! read-only preview (`projects.readFile`) under a breadcrumb subheader.

use crate::a11y::ConnA11yExt as _;
use std::fmt;

use conn_client::Connection;
use conn_contract::rpc::projects::{list_entries, read_file};
use conn_contract::{ProjectEntryKind, ProjectListEntriesInput, ProjectReadFileInput};
use conn_theme::Tokens;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    App, ClipboardItem, Context, Entity, InteractiveElement, IntoElement, MouseButton,
    ParentElement, Render, SharedString, Styled, Subscription, Window, div, px,
};

use super::color::to_hsla;
use super::header::superhero_icon;
use super::highlight::{HighlightSpan, highlight_lines};
use super::tree::FileTreeState;

/// Pierre tree compact row height (`FileBrowserPanel.tsx`: `itemHeight: 28`).
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
}

/// What the Files surfaces ask of the right panel.
#[derive(Clone, Debug)]
pub(crate) enum FilesEvent {
    /// A file row was clicked: open the file as its own tab.
    OpenFile(String),
}

impl gpui_kit::EventEmitter<FilesEvent> for FilesPanel {}

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
    search_input: Entity<InputState>,
    _subscriptions: Vec<Subscription>,
    context_generation: u64,
    preview_generation: u64,
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
            search_input,
            _subscriptions: vec![sub],
            context_generation: 0,
            preview_generation: 0,
        }
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

    fn refresh_files(&mut self, cx: &mut Context<'_, Self>) {
        if self.workspace_root.is_none() {
            return;
        }
        let expanded = self.tree.expanded_directories();
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

    /// Draws the file tab for `path`, loading it unless it is already shown.
    pub(crate) fn show_preview(&mut self, path: String, cx: &mut Context<'_, Self>) {
        self.showing_preview = true;
        let current = match &self.preview {
            PreviewState::Loaded { path, .. }
            | PreviewState::Loading(path)
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
        self.preview = PreviewState::Loading(path.clone());
        cx.notify();

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

    fn render_tree_toolbar(&self, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let field_bg = to_hsla(self.tokens.shell_field);
        let control_bg = to_hsla(self.tokens.shell_control);
        let control_border = to_hsla(self.tokens.shell_divider_header);
        let hover_bg = to_hsla(self.tokens.shell_highlight);
        let muted = to_hsla(self.tokens.muted_foreground);

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
                    .a11y_button("panel.files.refresh", "Refresh files")
                    .size(px(TOOLBAR_BTN_SIZE_PX))
                    .rounded(px(9999.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover_bg))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, _, _, cx| this.refresh_files(cx)),
                    )
                    .child(superhero_icon("superhero/refresh.svg", 14.0, muted)),
            );

        if has_dirs {
            explorer_actions = explorer_actions.child(
                div()
                    .id("files-toggle-expand-btn")
                    .a11y_button("panel.files.toggle-expand", "Expand or collapse folders")
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
        let hover_bg = to_hsla(self.tokens.shell_highlight);
        // Preview subheader: breadcrumb path (`text-sm`) + Copy/Wrap `ToolbarGroup` when a file is open.
        let active_path = match &self.preview {
            PreviewState::Loaded { path, .. }
            | PreviewState::Loading(path)
            | PreviewState::Error { path, .. } => Some(path.as_str()),
            PreviewState::Empty => None,
        };
        let has_contents = matches!(&self.preview, PreviewState::Loaded { .. });
        let wrap_icon_color = if self.word_wrap { fg } else { muted };

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
            preview_toolbar = preview_toolbar.child(render_breadcrumb(path, fg, muted));
            if has_contents {
                preview_toolbar = preview_toolbar.child(
                    h_flex()
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
                            // Pressed toggle brightens icon to `fg` with no fill (`nckrtl-shell-design`).
                            div()
                                .id("files-preview-wrap-btn")
                                .a11y_button("panel.files.preview-wrap", "Toggle line wrap")
                                .size(px(TOOLBAR_BTN_SIZE_PX))
                                .rounded(px(9999.0))
                                .flex()
                                .items_center()
                                .justify_center()
                                .cursor_pointer()
                                .hover(move |s| s.bg(hover_bg))
                                .on_mouse_down(
                                    MouseButton::Left,
                                    cx.listener(|this, _, _, cx| {
                                        this.word_wrap = !this.word_wrap;
                                        cx.notify();
                                    }),
                                )
                                .child(superhero_icon(
                                    "superhero/wrap-lines.svg",
                                    14.0,
                                    wrap_icon_color,
                                )),
                        )
                        .child(
                            div()
                                .id("files-preview-copy-btn")
                                .a11y_button("panel.files.preview-copy", "Copy file contents")
                                .size(px(TOOLBAR_BTN_SIZE_PX))
                                .rounded(px(9999.0))
                                .flex()
                                .items_center()
                                .justify_center()
                                .cursor_pointer()
                                .hover(move |s| s.bg(hover_bg))
                                .on_mouse_down(
                                    MouseButton::Left,
                                    cx.listener(|this, _, _, cx| {
                                        if let PreviewState::Loaded { raw_contents, .. } =
                                            &this.preview
                                        {
                                            cx.write_to_clipboard(ClipboardItem::new_string(
                                                raw_contents.clone(),
                                            ));
                                        }
                                    }),
                                )
                                .child(superhero_icon("superhero/copy.svg", 14.0, muted)),
                        ),
                );
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
            return col.child(muted_message("Loading files…", muted));
        }
        if let Some(err) = &self.tree_error {
            return col.child(muted_message(
                &format!("Failed to load files: {err}"),
                muted,
            ));
        }

        let rows = self.tree.visible_rows();
        if rows.is_empty() {
            let msg = if self.tree.query().trim().is_empty() {
                "This folder is empty."
            } else {
                "No matching files."
            };
            return col.child(muted_message(msg, muted));
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
            .overflow_y_scroll();

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

                    body = body.child(
                        h_flex()
                            .w_full()
                            .items_start()
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

impl Render for FilesPanel {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        if self.showing_preview {
            return v_flex()
                .size_full()
                .child(self.render_preview_subheader(cx))
                .child(self.render_preview_column(cx))
                .into_any_element();
        }
        v_flex()
            .size_full()
            .child(self.render_tree_toolbar(cx))
            .child(self.render_tree_column(cx))
            .into_any_element()
    }
}

fn render_breadcrumb(path: &str, fg: gpui_kit::Hsla, muted: gpui_kit::Hsla) -> impl IntoElement {
    let (dir, name) = match path.rsplit_once('/') {
        Some((d, f)) => (Some(d), f),
        None => (None, path),
    };
    let mut row = h_flex()
        .flex_1()
        .min_w_0()
        .items_center()
        .gap(px(4.0))
        .text_size(px(BREADCRUMB_TEXT_PX))
        .line_height(px(UI_LINE_HEIGHT_PX));
    if let Some(dir) = dir {
        row = row
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_color(muted)
                    .child(dir.to_owned()),
            )
            .child(div().flex_shrink_0().text_color(muted).child("/"));
    }
    row.child(div().flex_shrink_0().text_color(fg).child(name.to_owned()))
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
