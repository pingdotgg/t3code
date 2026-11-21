//! Files right-panel surface: soft search field, lazy directory tree (`projects.listEntries`),
//! and read-only syntect-highlighted source preview (`projects.readFile`).

use std::fmt;

use conn_client::Connection;
use conn_contract::rpc::projects::{list_entries, read_file};
use conn_contract::{ProjectEntryKind, ProjectListEntriesInput, ProjectReadFileInput};
use conn_theme::Tokens;
use gpui_kit::assets::IconName;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{Icon, h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    App, Context, Entity, InteractiveElement, IntoElement, MouseButton, ParentElement, Render,
    SharedString, Styled, Subscription, Window, div, px,
};

use super::color::to_hsla;
use super::highlight::{HighlightSpan, highlight_lines};
use super::tree::FileTreeState;

const TREE_COLUMN_WIDTH_PX: f32 = 240.0;
const TREE_ROW_HEIGHT_PX: f32 = 28.0;
const UI_TEXT_PX: f32 = 13.0;
const UI_LINE_HEIGHT_PX: f32 = 20.0;
const TOOLBAR_PAD_Y_PX: f32 = 7.5;
const TOOLBAR_PAD_START_PX: f32 = 16.0;
const TOOLBAR_PAD_END_PX: f32 = 11.5;

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

/// Files explorer and read-only source preview panel.
pub(crate) struct FilesPanel {
    tokens: Tokens,
    connection: Option<Connection>,
    workspace_root: Option<String>,
    tree: FileTreeState,
    tree_error: Option<String>,
    preview: PreviewState,
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
        let search_input = cx.new(|cx| InputState::new(window, cx).placeholder("Filter files..."));
        let sub = cx.subscribe(&search_input, |this, input, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                let query = input.read(cx).value().to_string();
                this.tree.set_query(query);
                cx.notify();
            }
        });
        Self {
            tokens,
            connection,
            workspace_root: None,
            tree: FileTreeState::default(),
            tree_error: None,
            preview: PreviewState::Empty,
            search_input,
            _subscriptions: vec![sub],
            context_generation: 0,
            preview_generation: 0,
        }
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

    fn render_toolbar(&self) -> impl IntoElement {
        let field_bg = to_hsla(self.tokens.shell_field);
        let field_border = to_hsla(self.tokens.shell_divider_header);
        let muted = to_hsla(self.tokens.muted_foreground);

        h_flex()
            .w_full()
            .pt(px(TOOLBAR_PAD_Y_PX))
            .pb(px(TOOLBAR_PAD_Y_PX))
            .pl(px(TOOLBAR_PAD_START_PX))
            .pr(px(TOOLBAR_PAD_END_PX))
            .items_center()
            .gap(px(8.0))
            .child(
                // Soft search field: h-8, pill radius, --shell-field fill, --shell-divider-header border.
                h_flex()
                    .flex_1()
                    .h(px(32.0))
                    .rounded(px(9999.0))
                    .bg(field_bg)
                    .border_1()
                    .border_color(field_border)
                    .pl(px(10.0))
                    .pr(px(10.0))
                    .gap(px(6.0))
                    .items_center()
                    .child(Icon::new(IconName::Search).size(px(14.0)).text_color(muted))
                    .child(
                        div().flex_1().min_w_0().child(
                            Input::new(&self.search_input)
                                .appearance(false)
                                .text_size(px(UI_TEXT_PX)),
                        ),
                    ),
            )
    }

    fn render_tree_column(&self, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let muted = to_hsla(self.tokens.muted_foreground);
        let fg = to_hsla(self.tokens.foreground);
        let highlight = to_hsla(self.tokens.shell_highlight);
        let hover_bg = to_hsla(self.tokens.foreground.with_alpha(0.04));

        let mut col = v_flex()
            .id("files-tree-scroll")
            .w(px(TREE_COLUMN_WIDTH_PX))
            .h_full()
            .flex_shrink_0()
            .overflow_y_scroll()
            .py(px(6.0))
            .px(px(6.0));

        if self.workspace_root.is_none() {
            return col.child(muted_message("Open a project to browse files.", muted));
        }
        if self.tree.is_root_loading() && !self.tree.has_loaded("") {
            return col.child(muted_message("Loading files...", muted));
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
            let indent_px = 10.0 + (row.depth as f32) * 14.0;
            let row_path = row.path.clone();
            let text_color = if row.ignored && !is_selected {
                muted
            } else if is_selected {
                fg
            } else {
                to_hsla(self.tokens.foreground)
            };

            let icon_name = if is_dir {
                if row.expanded {
                    IconName::FolderOpen
                } else {
                    IconName::Folder
                }
            } else {
                IconName::File
            };

            let item = h_flex()
                .id(SharedString::from(format!("tree-row-{}", row.path)))
                .w_full()
                .h(px(TREE_ROW_HEIGHT_PX))
                .pl(px(indent_px))
                .pr(px(8.0))
                .gap(px(6.0))
                .items_center()
                .rounded(px(6.0))
                .cursor_pointer()
                .when(is_selected, |el| el.bg(highlight))
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
                            this.open_file(row_path.clone(), cx);
                        }
                    }),
                )
                .child(if is_dir {
                    let chevron = if row.expanded {
                        IconName::ChevronDown
                    } else {
                        IconName::ChevronRight
                    };
                    div()
                        .w(px(12.0))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(Icon::new(chevron).size(px(12.0)).text_color(muted))
                } else {
                    div().w(px(12.0))
                })
                .child(Icon::new(icon_name).size(px(15.0)).text_color(muted))
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
        let mono_font = mono_font_family(cx);

        let container = v_flex()
            .id("files-preview-scroll")
            .flex_1()
            .min_w_0()
            .h_full()
            .overflow_y_scroll();

        match &self.preview {
            PreviewState::Empty => container
                .items_center()
                .justify_center()
                .child(muted_message("Select a file to preview.", muted)),
            PreviewState::Loading(path) => container
                .items_center()
                .justify_center()
                .child(muted_message(&format!("Loading {path}..."), muted)),
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
                let gutter_width = (gutter_digits as f32) * 8.0 + 16.0;
                let mut body = container.py(px(8.0)).px(px(12.0));

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
                        .line_height(px(UI_LINE_HEIGHT_PX));

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
                                    .pr(px(12.0))
                                    .text_right()
                                    .font_family(mono_font.clone())
                                    .text_size(px(UI_TEXT_PX))
                                    .line_height(px(UI_LINE_HEIGHT_PX))
                                    .text_color(muted)
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
        let divider = to_hsla(self.tokens.shell_divider);

        v_flex()
            .size_full()
            .child(self.render_toolbar())
            // One continuous horizontal divider under the toolbar across both columns.
            .child(div().w_full().h(px(1.0)).bg(divider))
            .child(
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .child(self.render_tree_column(cx))
                    // One vertical divider meeting the horizontal divider in a clean T.
                    .child(div().w(px(1.0)).h_full().bg(divider))
                    .child(self.render_preview_column(cx)),
            )
    }
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
