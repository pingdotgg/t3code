//! Diff right-panel surface: changed-files list + unified diff viewer from
//! `orchestration.getFullThreadDiff`, using a clean T-junction split.

use std::fmt;

use conn_client::Connection;
use conn_contract::OrchestrationGetFullThreadDiffInput;
use conn_contract::rpc::orchestration::get_full_thread_diff;
use conn_theme::Tokens;
use gpui_kit::assets::IconName;
use gpui_kit::component::{ActiveTheme as _, Icon, h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    Context, InteractiveElement, IntoElement, MouseButton, ParentElement, Render, SharedString,
    Styled, Window, div, px,
};
use serde_json::{Value, json};

use super::color::to_hsla;
use super::diff_parser::{DiffFile, DiffLineKind, parse_unified_diff};

const FILE_LIST_WIDTH_PX: f32 = 240.0;
const ROW_HEIGHT_PX: f32 = 28.0;
const UI_TEXT_PX: f32 = 13.0;
const UI_LINE_HEIGHT_PX: f32 = 20.0;
const TOOLBAR_PAD_Y_PX: f32 = 7.5;
const TOOLBAR_PAD_START_PX: f32 = 16.0;
const TOOLBAR_PAD_END_PX: f32 = 11.5;

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

        let summary_label = if file_count == 1 {
            "1 file changed".to_owned()
        } else {
            format!("{file_count} files changed")
        };

        h_flex()
            .w_full()
            .pt(px(TOOLBAR_PAD_Y_PX))
            .pb(px(TOOLBAR_PAD_Y_PX))
            .pl(px(TOOLBAR_PAD_START_PX))
            .pr(px(TOOLBAR_PAD_END_PX))
            .items_center()
            .justify_between()
            .gap(px(8.0))
            .child(
                h_flex()
                    .items_center()
                    .gap(px(8.0))
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .child(div().text_color(fg).child(summary_label))
                    .when(total_add > 0, |el| {
                        el.child(div().text_color(added).child(format!("+{total_add}")))
                    })
                    .when(total_del > 0, |el| {
                        el.child(div().text_color(removed).child(format!("-{total_del}")))
                    }),
            )
            .child(
                // ToolbarGroup pill: h-8, 3px padding, 24px ghost button inside.
                h_flex()
                    .h(px(32.0))
                    .p(px(3.0))
                    .rounded(px(9999.0))
                    .bg(control_bg)
                    .border_1()
                    .border_color(control_border)
                    .items_center()
                    .child(
                        div()
                            .id("diff-refresh-btn")
                            .size(px(24.0))
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
                            .child(
                                Icon::new(IconName::RefreshCw)
                                    .size(px(14.0))
                                    .text_color(muted),
                            ),
                    ),
            )
    }

    fn render_file_list(&self, files: &[DiffFile], cx: &mut Context<'_, Self>) -> impl IntoElement {
        let fg = to_hsla(self.tokens.foreground);
        let muted = to_hsla(self.tokens.muted_foreground);
        let added = to_hsla(self.tokens.diff_added);
        let removed = to_hsla(self.tokens.diff_removed);
        let highlight = to_hsla(self.tokens.shell_highlight);
        let hover_bg = to_hsla(self.tokens.foreground.with_alpha(0.04));

        let mut list = v_flex()
            .id("diff-files-scroll")
            .w(px(FILE_LIST_WIDTH_PX))
            .h_full()
            .flex_shrink_0()
            .overflow_y_scroll()
            .py(px(6.0))
            .px(px(6.0));

        for (idx, file) in files.iter().enumerate() {
            let selected = idx == self.selected_index;
            let row = h_flex()
                .id(SharedString::from(format!("diff-file-{idx}")))
                .w_full()
                .h(px(ROW_HEIGHT_PX))
                .px(px(10.0))
                .gap(px(6.0))
                .items_center()
                .rounded(px(6.0))
                .cursor_pointer()
                .when(selected, |el| el.bg(highlight))
                .when(!selected, |el| el.hover(move |s| s.bg(hover_bg)))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |this, _, _, cx| {
                        this.selected_index = idx;
                        cx.notify();
                    }),
                )
                .child(
                    Icon::new(IconName::FileDiff)
                        .size(px(14.0))
                        .text_color(muted),
                )
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
        let muted = to_hsla(self.tokens.muted_foreground);
        let added = to_hsla(self.tokens.diff_added);
        let added_bg = to_hsla(self.tokens.diff_added_background);
        let removed = to_hsla(self.tokens.diff_removed);
        let removed_bg = to_hsla(self.tokens.diff_removed_background);
        let hunk_bg = to_hsla(self.tokens.shell_field);
        let mono_font = cx.theme().mono_font_family.clone();

        let mut body = v_flex()
            .id("diff-body-scroll")
            .flex_1()
            .min_w_0()
            .h_full()
            .overflow_y_scroll()
            .py(px(6.0));

        if file.is_binary {
            return body.child(
                div()
                    .px(px(16.0))
                    .py(px(10.0))
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child("Binary file changed."),
            );
        }

        if file.hunks.is_empty() {
            return body.child(
                div()
                    .px(px(16.0))
                    .py(px(10.0))
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child("No textual diff lines."),
            );
        }

        for hunk in &file.hunks {
            body = body.child(
                div()
                    .w_full()
                    .px(px(12.0))
                    .py(px(2.0))
                    .bg(hunk_bg)
                    .font_family(mono_font.clone())
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child(hunk.header.clone()),
            );

            for line in &hunk.lines {
                let (row_bg, sign, sign_color) = match line.kind {
                    DiffLineKind::Added => (Some(added_bg), "+", added),
                    DiffLineKind::Removed => (Some(removed_bg), "-", removed),
                    DiffLineKind::Context => (None, " ", muted),
                };
                let old_no = line.old_line.map_or_else(String::new, |n| n.to_string());
                let new_no = line.new_line.map_or_else(String::new, |n| n.to_string());

                let mut row = h_flex()
                    .w_full()
                    .px(px(8.0))
                    .font_family(mono_font.clone())
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX));
                if let Some(bg) = row_bg {
                    row = row.bg(bg);
                }

                row = row
                    .child(
                        div()
                            .w(px(40.0))
                            .flex_shrink_0()
                            .pr(px(8.0))
                            .text_right()
                            .text_color(muted)
                            .child(old_no),
                    )
                    .child(
                        div()
                            .w(px(40.0))
                            .flex_shrink_0()
                            .pr(px(8.0))
                            .text_right()
                            .text_color(muted)
                            .child(new_no),
                    )
                    .child(
                        div()
                            .w(px(14.0))
                            .flex_shrink_0()
                            .text_color(sign_color)
                            .child(sign),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_color(fg)
                            .child(line.text.clone()),
                    );

                body = body.child(row);
            }
        }

        body
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
                .child(muted_text("Loading diff...", muted))
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
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .child(self.render_file_list(files, cx))
                    // Vertical divider meeting the horizontal toolbar divider in a clean T.
                    .child(div().w(px(1.0)).h_full().bg(divider))
                    .when_some(selected, |el, file| el.child(self.render_diff_body(file, cx)))
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
