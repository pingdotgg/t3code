//! Diff right-panel surface: Conn toolbar (scope pill, `DiffStatLabel`, `ToolbarGroup`),
//! toggleable Pierre-themed changed-files list, and unified diff viewer with Conn's
//! gutter tints and clean T-junction split.

use std::fmt;

use conn_client::Connection;
use conn_contract::OrchestrationGetFullThreadDiffInput;
use conn_contract::rpc::orchestration::get_full_thread_diff;
use conn_theme::{Appearance, Tokens, color_mix_srgb};
use gpui_kit::component::{ActiveTheme as _, h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    Context, FontWeight, InteractiveElement, IntoElement, MouseButton, ParentElement, Render,
    SharedString, Styled, Window, div, px,
};
use serde_json::{Value, json};

use super::color::to_hsla;
use super::diff_parser::{DiffFile, DiffLineKind, parse_unified_diff};
use super::header::{CONTROL_RADIUS_PX, superhero_icon};

const FILE_LIST_WIDTH_PX: f32 = 216.0;
const ROW_HEIGHT_PX: f32 = 28.0;
const ROW_RADIUS_PX: f32 = 5.0;
const UI_TEXT_PX: f32 = 13.0;
const UI_LINE_HEIGHT_PX: f32 = 20.0;
const TOOLBAR_PAD_Y_PX: f32 = 7.5;
const TOOLBAR_PAD_START_PX: f32 = 8.0;
const TOOLBAR_PAD_END_PX: f32 = 11.5;
const TOOLBAR_HEIGHT_PX: f32 = 32.0;
const TOOLBAR_INNER_PAD_PX: f32 = 3.0;
const TOOLBAR_BTN_SIZE_PX: f32 = 24.0;

#[derive(Clone, Debug)]
enum DiffLoadState {
    Empty,
    Loading,
    Loaded(Vec<DiffFile>),
    Error(String),
}

/// Thread diff panel displaying changed files on the left and unified diff hunks on the right.
pub(crate) struct DiffPanel {
    tokens: Tokens,
    connection: Option<Connection>,
    thread_id: Option<String>,
    turn_count: Option<i64>,
    state: DiffLoadState,
    selected_index: usize,
    word_wrap: bool,
    file_tree_open: bool,
    generation: u64,
}

impl fmt::Debug for DiffPanel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DiffPanel")
            .field("thread_id", &self.thread_id)
            .field("turn_count", &self.turn_count)
            .field("selected_index", &self.selected_index)
            .finish_non_exhaustive()
    }
}

impl DiffPanel {
    pub(crate) fn new(tokens: Tokens, connection: Option<Connection>) -> Self {
        Self {
            tokens,
            connection,
            thread_id: None,
            turn_count: None,
            state: DiffLoadState::Empty,
            selected_index: 0,
            word_wrap: false,
            file_tree_open: true,
            generation: 0,
        }
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens;
        cx.notify();
    }

    pub(crate) fn set_thread(&mut self, thread_id: Option<String>, cx: &mut Context<'_, Self>) {
        if self.thread_id == thread_id {
            return;
        }
        self.thread_id = thread_id;
        self.turn_count = None;
        self.selected_index = 0;
        self.reload(cx);
    }

    pub(crate) fn set_turn_count(&mut self, turn_count: Option<i64>, cx: &mut Context<'_, Self>) {
        if self.turn_count == turn_count {
            return;
        }
        self.turn_count = turn_count;
        if self.thread_id.is_some() {
            self.reload(cx);
        }
    }

    pub(crate) fn reload(&mut self, cx: &mut Context<'_, Self>) {
        self.generation = self.generation.wrapping_add(1);
        let generation = self.generation;

        let Some(thread_id) = self.thread_id.clone() else {
            self.state = DiffLoadState::Empty;
            cx.notify();
            return;
        };
        let Some(conn) = self.connection.clone() else {
            self.state = DiffLoadState::Error("Not connected to server.".to_owned());
            cx.notify();
            return;
        };

        let explicit_turns = self.turn_count;
        self.state = DiffLoadState::Loading;
        cx.notify();

        cx.spawn(async move |this, cx| {
            let to_turn_count = match explicit_turns {
                Some(n) => Ok(n),
                None => resolve_latest_turn_count(&conn, &thread_id).await,
            };

            let result = match to_turn_count {
                Ok(0) => Ok(Vec::new()),
                Ok(to_turn_count) => {
                    let payload = OrchestrationGetFullThreadDiffInput {
                        thread_id,
                        to_turn_count,
                        ignore_whitespace: None,
                    };
                    conn.call::<get_full_thread_diff::Payload, get_full_thread_diff::Success>(
                        "orchestration.getFullThreadDiff",
                        &payload,
                    )
                    .await
                    .map(|resp| parse_unified_diff(&resp.diff))
                    .map_err(|e| e.to_string())
                }
                Err(err) => Err(err),
            };

            let _ = this.update(cx, |panel, cx| {
                if panel.generation != generation {
                    return;
                }
                match result {
                    Ok(files) => {
                        panel.selected_index = 0;
                        panel.state = DiffLoadState::Loaded(files);
                    }
                    Err(err) => {
                        panel.state = DiffLoadState::Error(err);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn render_toolbar(&self, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let fg = to_hsla(self.tokens.foreground);
        let muted = to_hsla(self.tokens.muted_foreground);
        let added = to_hsla(self.tokens.diff_added);
        let removed = to_hsla(self.tokens.diff_removed);
        let control_bg = to_hsla(self.tokens.shell_control);
        let control_border = to_hsla(self.tokens.shell_divider_header);
        let hover_bg = to_hsla(self.tokens.shell_highlight);

        let (file_count, total_add, total_del) = match &self.state {
            DiffLoadState::Loaded(files) => (
                files.len(),
                files.iter().map(|f| f.additions).sum::<usize>(),
                files.iter().map(|f| f.deletions).sum::<usize>(),
            ),
            _ => (0, 0, 0),
        };

        let file_count_label = if file_count == 1 {
            "1 file".to_owned()
        } else {
            format!("{file_count} files")
        };

        let wrap_color = if self.word_wrap { fg } else { muted };
        let tree_color = if self.file_tree_open { fg } else { muted };

        h_flex()
            .w_full()
            .py(px(TOOLBAR_PAD_Y_PX))
            .pl(px(TOOLBAR_PAD_START_PX))
            .pr(px(TOOLBAR_PAD_END_PX))
            .items_center()
            .justify_between()
            .gap(px(8.0))
            .child(
                h_flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        // Scope trigger pill matching `DiffPanel.tsx` (`size="xs" variant="secondary"`, 6px radius).
                        h_flex()
                            .h(px(28.0))
                            .px(px(8.0))
                            .gap(px(4.0))
                            .items_center()
                            .rounded(px(CONTROL_RADIUS_PX))
                            .bg(control_bg)
                            .border_1()
                            .border_color(control_border)
                            .text_size(px(UI_TEXT_PX))
                            .line_height(px(UI_LINE_HEIGHT_PX))
                            .text_color(fg)
                            .child("Changes"),
                    )
                    .when(file_count > 0, |el| {
                        el.child(
                            div()
                                .text_size(px(UI_TEXT_PX))
                                .line_height(px(UI_LINE_HEIGHT_PX))
                                .text_color(muted)
                                .child(file_count_label),
                        )
                    }),
            )
            .child(
                h_flex()
                    .flex_shrink_0()
                    .items_center()
                    .gap(px(8.0))
                    .when(total_add > 0 || total_del > 0, |el| {
                        el.child(
                            h_flex()
                                .items_center()
                                .gap(px(6.0))
                                .text_size(px(UI_TEXT_PX))
                                .line_height(px(UI_LINE_HEIGHT_PX))
                                .when(total_add > 0, |el| {
                                    el.child(div().text_color(added).child(format!("+{total_add}")))
                                })
                                .when(total_del > 0, |el| {
                                    el.child(
                                        div().text_color(removed).child(format!("-{total_del}")),
                                    )
                                }),
                        )
                    })
                    .child(
                        // ToolbarGroup pill: h-8, 3px inner padding, 24px ghost buttons inside.
                        // Pressed toggles brighten their icon to `fg` with no fill (`nckrtl-shell-design`).
                        h_flex()
                            .h(px(TOOLBAR_HEIGHT_PX))
                            .px(px(TOOLBAR_INNER_PAD_PX))
                            .gap(px(2.0))
                            .rounded(px(9999.0))
                            .bg(control_bg)
                            .border_1()
                            .border_color(control_border)
                            .items_center()
                            .child(
                                div()
                                    .id("diff-refresh-btn")
                                    .size(px(TOOLBAR_BTN_SIZE_PX))
                                    .rounded(px(9999.0))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .cursor_pointer()
                                    .hover(move |s| s.bg(hover_bg))
                                    .on_mouse_down(
                                        MouseButton::Left,
                                        cx.listener(|this, _, _, cx| this.reload(cx)),
                                    )
                                    .child(superhero_icon("superhero/refresh.svg", 14.0, muted)),
                            )
                            .child(
                                div()
                                    .id("diff-wrap-btn")
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
                                        wrap_color,
                                    )),
                            )
                            .child(
                                div()
                                    .id("diff-tree-toggle-btn")
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
                                            this.file_tree_open = !this.file_tree_open;
                                            cx.notify();
                                        }),
                                    )
                                    .child(superhero_icon(
                                        "superhero/file-tree.svg",
                                        14.0,
                                        tree_color,
                                    )),
                            ),
                    ),
            )
    }

    fn render_file_list(&self, files: &[DiffFile], cx: &mut Context<'_, Self>) -> impl IntoElement {
        let fg = to_hsla(self.tokens.foreground);
        let muted = to_hsla(self.tokens.muted_foreground);
        let added = to_hsla(self.tokens.diff_added);
        let removed = to_hsla(self.tokens.diff_removed);
        let hover_bg = to_hsla(self.tokens.shell_highlight);
        let selected_bg = to_hsla(self.tokens.foreground.with_alpha(0.11));

        let mut list = v_flex()
            .id("diff-files-scroll")
            .w(px(FILE_LIST_WIDTH_PX))
            .h_full()
            .flex_shrink_0()
            .overflow_y_scroll()
            .py(px(4.0))
            .px(px(6.0));

        for (idx, file) in files.iter().enumerate() {
            let selected = idx == self.selected_index;
            let row = h_flex()
                .id(SharedString::from(format!("diff-file-{idx}")))
                .mx(px(2.0))
                .h(px(ROW_HEIGHT_PX))
                .px(px(8.0))
                .gap(px(6.0))
                .items_center()
                .rounded(px(ROW_RADIUS_PX))
                .cursor_pointer()
                .when(selected, |el| el.bg(selected_bg))
                .when(!selected, |el| el.hover(move |s| s.bg(hover_bg)))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |this, _, _, cx| {
                        this.selected_index = idx;
                        cx.notify();
                    }),
                )
                .child(superhero_icon("superhero/file-diff.svg", 14.0, muted))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(px(UI_TEXT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .text_color(fg)
                        .child(file.display_path.clone()),
                )
                .child(
                    h_flex()
                        .flex_shrink_0()
                        .gap(px(4.0))
                        .text_size(px(UI_TEXT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .when(file.additions > 0, |el| {
                            el.child(
                                div()
                                    .text_color(added)
                                    .child(format!("+{}", file.additions)),
                            )
                        })
                        .when(file.deletions > 0, |el| {
                            el.child(
                                div()
                                    .text_color(removed)
                                    .child(format!("-{}", file.deletions)),
                            )
                        }),
                );
            list = list.child(row);
        }

        list
    }

    fn render_diff_body(&self, file: &DiffFile, cx: &Context<'_, Self>) -> impl IntoElement {
        let fg = to_hsla(self.tokens.code_foreground);
        let ui_fg = to_hsla(self.tokens.foreground);
        let muted = to_hsla(self.tokens.muted_foreground);
        let gutter_fg = to_hsla(self.tokens.muted_foreground.with_alpha(0.65));
        let divider = to_hsla(self.tokens.shell_divider);
        let added = to_hsla(self.tokens.diff_added);
        let removed = to_hsla(self.tokens.diff_removed);
        let mono_font = cx.theme().mono_font_family.clone();

        // Derive Conn's diff row & gutter backgrounds from `--code-background` (re-rooted to
        // `--shell-card` in the right panel) matching `lib/diffRendering.ts`.
        let code_bg = self.tokens.shell_card;
        let is_dark = self.tokens.appearance == Appearance::Dark;
        let line_weight = if is_dark { 0.70 } else { 0.50 };
        let gutter_weight = if is_dark { 0.60 } else { 0.35 };
        let added_bg = to_hsla(color_mix_srgb(
            code_bg,
            line_weight,
            self.tokens.diff_added_background,
        ));
        let added_gutter_bg = to_hsla(color_mix_srgb(
            code_bg,
            gutter_weight,
            self.tokens.diff_added_background,
        ));
        let removed_bg = to_hsla(color_mix_srgb(
            code_bg,
            line_weight,
            self.tokens.diff_removed_background,
        ));
        let removed_gutter_bg = to_hsla(color_mix_srgb(
            code_bg,
            gutter_weight,
            self.tokens.diff_removed_background,
        ));
        let separator_bg = to_hsla(color_mix_srgb(code_bg, 0.95, self.tokens.code_foreground));

        let file_header = h_flex()
            .w_full()
            .h(px(32.0))
            .flex_shrink_0()
            .px(px(12.0))
            .gap(px(8.0))
            .items_center()
            .justify_between()
            .border_b_1()
            .border_color(divider)
            .child(
                h_flex()
                    .flex_1()
                    .min_w_0()
                    .items_center()
                    .gap(px(6.0))
                    .child(superhero_icon("superhero/file-diff.svg", 14.0, muted))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(UI_TEXT_PX))
                            .line_height(px(UI_LINE_HEIGHT_PX))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(ui_fg)
                            .child(file.display_path.clone()),
                    ),
            )
            .child(
                h_flex()
                    .flex_shrink_0()
                    .gap(px(6.0))
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .when(file.additions > 0, |el| {
                        el.child(
                            div()
                                .text_color(added)
                                .child(format!("+{}", file.additions)),
                        )
                    })
                    .when(file.deletions > 0, |el| {
                        el.child(
                            div()
                                .text_color(removed)
                                .child(format!("-{}", file.deletions)),
                        )
                    }),
            );

        let mut scroll = v_flex()
            .id("diff-body-scroll")
            .flex_1()
            .min_h_0()
            .w_full()
            .overflow_y_scroll()
            .pb(px(12.0));

        if file.is_binary {
            scroll = scroll.child(
                div()
                    .px(px(16.0))
                    .py(px(12.0))
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child("Binary file changed."),
            );
            return v_flex()
                .flex_1()
                .min_w_0()
                .h_full()
                .child(file_header)
                .child(scroll);
        }

        if file.hunks.is_empty() {
            scroll = scroll.child(
                div()
                    .px(px(16.0))
                    .py(px(12.0))
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child("No textual diff lines."),
            );
            return v_flex()
                .flex_1()
                .min_w_0()
                .h_full()
                .child(file_header)
                .child(scroll);
        }

        for (hunk_idx, hunk) in file.hunks.iter().enumerate() {
            scroll = scroll.child(
                div()
                    .w_full()
                    .px(px(12.0))
                    .py(px(3.0))
                    .bg(separator_bg)
                    .when(hunk_idx > 0, |el| el.border_t_1().border_color(divider))
                    .border_b_1()
                    .border_color(divider)
                    .font_family(mono_font.clone())
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child(hunk.header.clone()),
            );

            for line in &hunk.lines {
                let (row_bg, gutter_bg, sign, sign_color) = match line.kind {
                    DiffLineKind::Added => (Some(added_bg), Some(added_gutter_bg), "+", added),
                    DiffLineKind::Removed => {
                        (Some(removed_bg), Some(removed_gutter_bg), "-", removed)
                    }
                    DiffLineKind::Context => (None, None, " ", muted),
                };
                let old_no = line.old_line.map_or_else(String::new, |n| n.to_string());
                let new_no = line.new_line.map_or_else(String::new, |n| n.to_string());

                let mut gutter = h_flex()
                    .flex_shrink_0()
                    .items_start()
                    .border_r_1()
                    .border_color(divider)
                    .when_some(gutter_bg, |el, bg| el.bg(bg))
                    .child(
                        div()
                            .w(px(36.0))
                            .flex_shrink_0()
                            .pr(px(6.0))
                            .text_right()
                            .text_color(gutter_fg)
                            .child(old_no),
                    )
                    .child(
                        div()
                            .w(px(36.0))
                            .flex_shrink_0()
                            .pr(px(8.0))
                            .text_right()
                            .text_color(gutter_fg)
                            .child(new_no),
                    );
                if gutter_bg.is_none() {
                    gutter = gutter.bg(to_hsla(code_bg));
                }

                let mut row = h_flex()
                    .w_full()
                    .font_family(mono_font.clone())
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX));
                if let Some(bg) = row_bg {
                    row = row.bg(bg);
                }

                row = row
                    .child(gutter)
                    .child(
                        div()
                            .w(px(18.0))
                            .flex_shrink_0()
                            .text_center()
                            .text_color(sign_color)
                            .child(sign),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .pr(px(12.0))
                            .when(!self.word_wrap, |el| {
                                el.overflow_hidden().whitespace_nowrap()
                            })
                            .text_color(fg)
                            .child(line.text.clone()),
                    );

                scroll = scroll.child(row);
            }
        }

        v_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .child(file_header)
            .child(scroll)
    }
}

impl Render for DiffPanel {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let divider = to_hsla(self.tokens.shell_divider);
        let muted = to_hsla(self.tokens.muted_foreground);

        let content = match &self.state {
            DiffLoadState::Empty => v_flex()
                .flex_1()
                .size_full()
                .items_center()
                .justify_center()
                .child(muted_text("Select a thread to view its diff.", muted))
                .into_any_element(),
            DiffLoadState::Loading => v_flex()
                .flex_1()
                .size_full()
                .items_center()
                .justify_center()
                .child(muted_text("Loading diff…", muted))
                .into_any_element(),
            DiffLoadState::Error(err) => v_flex()
                .flex_1()
                .size_full()
                .items_center()
                .justify_center()
                .px(px(16.0))
                .child(muted_text(&format!("Could not load diff: {err}"), muted))
                .into_any_element(),
            DiffLoadState::Loaded(files) if files.is_empty() => v_flex()
                .flex_1()
                .size_full()
                .items_center()
                .justify_center()
                .child(muted_text("No changes in this thread.", muted))
                .into_any_element(),
            DiffLoadState::Loaded(files) => {
                let selected = files.get(self.selected_index).or_else(|| files.first());
                let mut split = h_flex().flex_1().min_h_0().w_full();
                if self.file_tree_open {
                    split = split
                        .child(self.render_file_list(files, cx))
                        // Vertical divider meeting the horizontal toolbar divider in a clean T.
                        .child(div().w(px(1.0)).h_full().bg(divider));
                }
                split
                    .when_some(selected, |el, file| {
                        el.child(self.render_diff_body(file, cx))
                    })
                    .into_any_element()
            }
        };

        v_flex()
            .size_full()
            .child(self.render_toolbar(cx))
            // One continuous horizontal divider under the toolbar across both columns.
            .child(div().w_full().h(px(1.0)).bg(divider))
            .child(content)
    }
}

fn muted_text(text: &str, color: gpui_kit::Hsla) -> impl IntoElement {
    div()
        .text_size(px(UI_TEXT_PX))
        .line_height(px(UI_LINE_HEIGHT_PX))
        .text_color(color)
        .child(text.to_owned())
}

/// Queries `orchestration.getThreadProjection` to find the highest ready checkpoint turn ordinal
/// when the caller did not pass an explicit `turn_count`.
async fn resolve_latest_turn_count(conn: &Connection, thread_id: &str) -> Result<i64, String> {
    let projection: Value = conn
        .call_json(
            "orchestration.getThreadProjection",
            json!({ "threadId": thread_id }),
        )
        .await
        .map_err(|e| e.to_string())?;

    let checkpoints = projection
        .get("checkpoints")
        .or_else(|| projection.get("thread").and_then(|t| t.get("checkpoints")))
        .and_then(Value::as_array);

    let max_ordinal = checkpoints
        .into_iter()
        .flatten()
        .filter(|cp| cp.get("status").and_then(Value::as_str) == Some("ready"))
        .filter_map(|cp| {
            cp.get("appRunOrdinal")
                .or_else(|| cp.get("turnCount"))
                .and_then(Value::as_i64)
        })
        .max()
        .unwrap_or(0);

    Ok(max_ordinal)
}
