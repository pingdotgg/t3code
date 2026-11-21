//! Diff right-panel surface: Conn toolbar (scope pill, `DiffStatLabel`, `ToolbarGroup`),
//! toggleable Pierre-themed changed-files list, and unified diff viewer with Conn's
//! gutter tints and clean T-junction split.

use std::fmt;

use conn_client::Connection;
use conn_contract::rpc::orchestration::{get_full_thread_diff, get_turn_diff};
use conn_contract::{OrchestrationGetFullThreadDiffInput, OrchestrationGetTurnDiffInput};
use conn_theme::{Appearance, Tokens, color_mix_srgb};
use gpui_kit::component::{ActiveTheme as _, h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    Context, CursorStyle, FontWeight, InteractiveElement, IntoElement, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, ParentElement, Render, SharedString, Styled, Window, deferred,
    div, px,
};
use serde_json::{Value, json};

use super::chrome::ConnTooltipExt as _;
use super::color::to_hsla;
use super::diff_parser::{DiffFile, DiffLine, DiffLineKind, parse_unified_diff};
use super::header::{CONTROL_RADIUS_PX, superhero_icon};
use super::highlight::{HighlightSpan, highlight_lines};

const FILE_LIST_WIDTH_PX: f32 = 216.0;
const FILE_LIST_MIN_WIDTH_PX: f32 = 140.0;
const FILE_LIST_MAX_WIDTH_PX: f32 = 420.0;
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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum DiffViewMode {
    #[default]
    Unified,
    Split,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum DiffScope {
    #[default]
    AllChanges,
    Turn {
        from: i64,
        to: i64,
    },
}

impl DiffScope {
    fn label(self) -> String {
        match self {
            Self::AllChanges => "All changes".to_owned(),
            Self::Turn { to, .. } => format!("Turn {to}"),
        }
    }
}

/// Thread diff panel displaying changed files on the left and unified or split diff hunks on the right.
pub(crate) struct DiffPanel {
    tokens: Tokens,
    connection: Option<Connection>,
    thread_id: Option<String>,
    turn_count: Option<i64>,
    available_turns: Vec<i64>,
    scope: DiffScope,
    scope_menu_open: bool,
    state: DiffLoadState,
    selected_index: usize,
    view_mode: DiffViewMode,
    word_wrap: bool,
    file_tree_open: bool,
    file_list_width: f32,
    split_drag: Option<(f32, f32)>,
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
            available_turns: Vec::new(),
            scope: DiffScope::AllChanges,
            scope_menu_open: false,
            state: DiffLoadState::Empty,
            selected_index: 0,
            view_mode: DiffViewMode::Unified,
            word_wrap: false,
            file_tree_open: true,
            file_list_width: FILE_LIST_WIDTH_PX,
            split_drag: None,
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
        self.available_turns.clear();
        self.scope = DiffScope::AllChanges;
        self.scope_menu_open = false;
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
        let scope = self.scope;
        self.state = DiffLoadState::Loading;
        cx.notify();

        cx.spawn(async move |this, cx| {
            let discovered_turns = resolve_checkpoint_turns(&conn, &thread_id).await;
            let turns_for_ui = discovered_turns.as_ref().cloned().unwrap_or_default();

            let result = match scope {
                DiffScope::AllChanges => {
                    let to_turn_count = match explicit_turns {
                        Some(n) => Ok(n),
                        None => discovered_turns.map(|v| v.last().copied().unwrap_or(0)),
                    };
                    match to_turn_count {
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
                    }
                }
                DiffScope::Turn { from, to } => {
                    let payload = OrchestrationGetTurnDiffInput {
                        from_turn_count: from,
                        to_turn_count: to,
                        thread_id,
                        ignore_whitespace: None,
                    };
                    conn.call::<get_turn_diff::Payload, get_turn_diff::Success>(
                        "orchestration.getTurnDiff",
                        &payload,
                    )
                    .await
                    .map(|resp| parse_unified_diff(&resp.diff))
                    .map_err(|e| e.to_string())
                }
            };

            let _ = this.update(cx, |panel, cx| {
                if panel.generation != generation {
                    return;
                }
                if !turns_for_ui.is_empty() {
                    panel.available_turns = turns_for_ui;
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
        let split_color = if self.view_mode == DiffViewMode::Split {
            fg
        } else {
            muted
        };
        let split_icon = match self.view_mode {
            DiffViewMode::Unified => "superhero/diff-split.svg",
            DiffViewMode::Split => "superhero/diff-unified.svg",
        };

        let has_turns = !self.available_turns.is_empty();
        let mut scope_slot = div().relative().child(
            // Scope trigger pill matching `DiffPanel.tsx` (`size="xs" variant="secondary"`, 6px radius).
            h_flex()
                .id("diff-scope-trigger")
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
                .when(has_turns, |el| {
                    el.cursor_pointer()
                        .hover(move |s| s.bg(hover_bg))
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _, _, cx| {
                                cx.stop_propagation();
                                this.scope_menu_open = !this.scope_menu_open;
                                cx.notify();
                            }),
                        )
                })
                .child(self.scope.label())
                .when(has_turns, |el| {
                    el.child(superhero_icon("superhero/chevron-down.svg", 12.0, muted))
                }),
        );
        if self.scope_menu_open && has_turns {
            let pop_bg = to_hsla(self.tokens.popover);
            let pop_fg = to_hsla(self.tokens.popover_foreground);
            let pop_border = to_hsla(self.tokens.shell_inner_border);
            let mut menu = v_flex()
                .id("diff-scope-menu")
                .absolute()
                .top_full()
                .left_0()
                .mt(px(4.0))
                .w(px(164.0))
                .max_h(px(240.0))
                .overflow_y_scroll()
                .rounded(px(8.0))
                .bg(pop_bg)
                .border_1()
                .border_color(pop_border)
                .shadow_md()
                .p(px(4.0))
                .gap(px(2.0))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation());

            let all_selected = self.scope == DiffScope::AllChanges;
            menu = menu.child(
                h_flex()
                    .id("diff-scope-all")
                    .h(px(26.0))
                    .px(px(8.0))
                    .gap(px(6.0))
                    .items_center()
                    .rounded(px(5.0))
                    .cursor_pointer()
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(pop_fg)
                    .hover(move |s| s.bg(hover_bg))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, _, _, cx| {
                            cx.stop_propagation();
                            this.scope_menu_open = false;
                            if this.scope != DiffScope::AllChanges {
                                this.scope = DiffScope::AllChanges;
                                this.reload(cx);
                            } else {
                                cx.notify();
                            }
                        }),
                    )
                    .child(div().flex_1().child("All changes"))
                    .when(all_selected, |el| {
                        el.child(superhero_icon("superhero/check.svg", 13.0, pop_fg))
                    }),
            );

            for (idx, &turn) in self.available_turns.iter().enumerate() {
                let prev = idx
                    .checked_sub(1)
                    .and_then(|p| self.available_turns.get(p).copied())
                    .unwrap_or(0);
                let target = DiffScope::Turn {
                    from: prev,
                    to: turn,
                };
                let selected = self.scope == target;
                menu = menu.child(
                    h_flex()
                        .id(SharedString::from(format!("diff-scope-turn-{turn}")))
                        .h(px(26.0))
                        .px(px(8.0))
                        .gap(px(6.0))
                        .items_center()
                        .rounded(px(5.0))
                        .cursor_pointer()
                        .text_size(px(UI_TEXT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .text_color(if selected { pop_fg } else { muted })
                        .hover(move |s| s.bg(hover_bg).text_color(pop_fg))
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(move |this, _, _, cx| {
                                cx.stop_propagation();
                                this.scope_menu_open = false;
                                if this.scope != target {
                                    this.scope = target;
                                    this.reload(cx);
                                } else {
                                    cx.notify();
                                }
                            }),
                        )
                        .child(div().flex_1().child(format!("Turn {turn}")))
                        .when(selected, |el| {
                            el.child(superhero_icon("superhero/check.svg", 13.0, pop_fg))
                        }),
                );
            }
            scope_slot = scope_slot.child(deferred(menu).with_priority(3));
        }

        h_flex()
            .w_full()
            .py(px(TOOLBAR_PAD_Y_PX))
            .pl(px(TOOLBAR_PAD_START_PX))
            .pr(px(TOOLBAR_PAD_END_PX))
            .items_center()
            .justify_between()
            .gap(px(8.0))
            .child(h_flex().items_center().gap(px(8.0)).child(scope_slot).when(
                file_count > 0,
                |el| {
                    el.child(
                        div()
                            .text_size(px(UI_TEXT_PX))
                            .line_height(px(UI_LINE_HEIGHT_PX))
                            .text_color(muted)
                            .child(file_count_label),
                    )
                },
            ))
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
                                    .conn_tooltip("Refresh diff", &self.tokens)
                                    .child(superhero_icon("superhero/refresh.svg", 14.0, muted)),
                            )
                            .child(
                                div()
                                    .id("diff-mode-toggle-btn")
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
                                            this.view_mode = match this.view_mode {
                                                DiffViewMode::Unified => DiffViewMode::Split,
                                                DiffViewMode::Split => DiffViewMode::Unified,
                                            };
                                            cx.notify();
                                        }),
                                    )
                                    .conn_tooltip(
                                        match self.view_mode {
                                            DiffViewMode::Unified => "Split diff",
                                            DiffViewMode::Split => "Unified diff",
                                        },
                                        &self.tokens,
                                    )
                                    .child(superhero_icon(split_icon, 14.0, split_color)),
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
                                    .conn_tooltip("Wrap lines", &self.tokens)
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
                                    .conn_tooltip("Toggle file tree", &self.tokens)
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
            .w(px(self.file_list_width))
            .h_full()
            .flex_shrink_0()
            .overflow_y_scroll()
            .py(px(4.0))
            .px(px(6.0));

        for (idx, file) in files.iter().enumerate() {
            let selected = idx == self.selected_index;
            let resolved_icon = crate::file_icons::file_icon(&file.display_path);
            let icon_color = resolved_icon
                .color
                .map(|c| to_hsla(c.for_appearance(self.tokens.appearance)))
                .unwrap_or(muted);
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
                .child(superhero_icon(resolved_icon.asset, 14.0, icon_color))
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

        let header_icon = crate::file_icons::file_icon(&file.display_path);
        let header_icon_color = header_icon
            .color
            .map(|c| to_hsla(c.for_appearance(self.tokens.appearance)))
            .unwrap_or(muted);

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
                    .child(superhero_icon(header_icon.asset, 14.0, header_icon_color))
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

        // Syntax-highlight all diff lines in one pass so keywords, strings, and comments color
        // consistently with `FilesPanel`.
        let mut all_source = String::new();
        for hunk in &file.hunks {
            for line in &hunk.lines {
                all_source.push_str(&line.text);
                all_source.push('\n');
            }
        }
        let highlighted = highlight_lines(&file.display_path, &all_source, &self.tokens);
        let mut highlight_idx = 0usize;

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

            let hunk_highlight_base = highlight_idx;
            highlight_idx += hunk.lines.len();

            if self.view_mode == DiffViewMode::Split {
                let pairs = pair_split_diff_rows(&hunk.lines);
                for (left_idx, right_idx) in pairs {
                    let render_side = |line_opt: Option<usize>| {
                        let Some(idx) = line_opt else {
                            return h_flex()
                                .flex_1()
                                .min_w_0()
                                .font_family(mono_font.clone())
                                .text_size(px(UI_TEXT_PX))
                                .line_height(px(UI_LINE_HEIGHT_PX))
                                .child(
                                    div()
                                        .w(px(38.0))
                                        .flex_shrink_0()
                                        .border_r_1()
                                        .border_color(divider)
                                        .child(" "),
                                )
                                .child(div().flex_1().min_w_0().child(" "));
                        };
                        let line = &hunk.lines[idx];
                        let spans = highlighted
                            .get(hunk_highlight_base + idx)
                            .map(Vec::as_slice);
                        let (row_bg, gutter_bg, sign, sign_color, line_no) = match line.kind {
                            DiffLineKind::Added => (
                                Some(added_bg),
                                Some(added_gutter_bg),
                                "+",
                                added,
                                line.new_line.map_or_else(String::new, |n| n.to_string()),
                            ),
                            DiffLineKind::Removed => (
                                Some(removed_bg),
                                Some(removed_gutter_bg),
                                "-",
                                removed,
                                line.old_line.map_or_else(String::new, |n| n.to_string()),
                            ),
                            DiffLineKind::Context => (
                                None,
                                None,
                                " ",
                                muted,
                                line.old_line
                                    .or(line.new_line)
                                    .map_or_else(String::new, |n| n.to_string()),
                            ),
                        };
                        let mut side = h_flex()
                            .flex_1()
                            .min_w_0()
                            .font_family(mono_font.clone())
                            .text_size(px(UI_TEXT_PX))
                            .line_height(px(UI_LINE_HEIGHT_PX));
                        if let Some(bg) = row_bg {
                            side = side.bg(bg);
                        }
                        side.child(
                            div()
                                .w(px(38.0))
                                .flex_shrink_0()
                                .pr(px(6.0))
                                .border_r_1()
                                .border_color(divider)
                                .when_some(gutter_bg, |el, bg| el.bg(bg))
                                .text_right()
                                .text_color(gutter_fg)
                                .child(line_no),
                        )
                        .child(
                            div()
                                .w(px(16.0))
                                .flex_shrink_0()
                                .text_center()
                                .text_color(sign_color)
                                .child(sign),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .pr(px(8.0))
                                .when(!self.word_wrap, |el| {
                                    el.overflow_hidden().whitespace_nowrap()
                                })
                                .text_color(fg)
                                .child(styled_diff_line(&line.text, spans)),
                        )
                    };

                    scroll = scroll.child(
                        h_flex()
                            .w_full()
                            .items_stretch()
                            .child(render_side(left_idx))
                            .child(div().w(px(1.0)).flex_shrink_0().bg(divider))
                            .child(render_side(right_idx)),
                    );
                }
                continue;
            }

            for (offset, line) in hunk.lines.iter().enumerate() {
                let spans = highlighted
                    .get(hunk_highlight_base + offset)
                    .map(Vec::as_slice);

                let (row_bg, gutter_bg, sign, sign_color) = match line.kind {
                    DiffLineKind::Added => (Some(added_bg), Some(added_gutter_bg), "+", added),
                    DiffLineKind::Removed => {
                        (Some(removed_bg), Some(removed_gutter_bg), "-", removed)
                    }
                    DiffLineKind::Context => (None, None, " ", muted),
                };
                let old_no = line.old_line.map_or_else(String::new, |n| n.to_string());
                let new_no = line.new_line.map_or_else(String::new, |n| n.to_string());

                let gutter = h_flex()
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
                            .child(styled_diff_line(&line.text, spans)),
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
                    let split_handle = div()
                        .id("diff-split-handle")
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .left(px(-3.0))
                        .w(px(7.0))
                        .cursor(CursorStyle::ResizeLeftRight)
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, event: &MouseDownEvent, _, cx| {
                                cx.stop_propagation();
                                if event.click_count >= 2 {
                                    this.file_list_width = FILE_LIST_WIDTH_PX;
                                    this.split_drag = None;
                                } else {
                                    this.split_drag =
                                        Some((f32::from(event.position.x), this.file_list_width));
                                }
                                cx.notify();
                            }),
                        );
                    split = split
                        .child(self.render_file_list(files, cx))
                        // Vertical divider meeting the horizontal toolbar divider in a clean T,
                        // with a 7px drag target (double-click resets width).
                        .child(
                            div()
                                .relative()
                                .w(px(1.0))
                                .h_full()
                                .flex_shrink_0()
                                .bg(divider)
                                .child(split_handle),
                        );
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
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| {
                    if this.scope_menu_open {
                        this.scope_menu_open = false;
                        cx.notify();
                    }
                }),
            )
            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _, cx| {
                if let Some((from_x, start)) = this.split_drag {
                    let next = (start + (f32::from(event.position.x) - from_x))
                        .clamp(FILE_LIST_MIN_WIDTH_PX, FILE_LIST_MAX_WIDTH_PX);
                    if (next - this.file_list_width).abs() > 0.5 {
                        this.file_list_width = next;
                        cx.notify();
                    }
                }
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _: &MouseUpEvent, _, cx| {
                    if this.split_drag.take().is_some() {
                        cx.notify();
                    }
                }),
            )
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

/// Renders one diff line with syntect [`HighlightSpan`] runs via `StyledText`.
fn styled_diff_line(fallback: &str, spans: Option<&[HighlightSpan]>) -> gpui_kit::StyledText {
    let Some(spans) = spans else {
        return gpui_kit::StyledText::new(if fallback.is_empty() {
            " ".to_owned()
        } else {
            fallback.to_owned()
        });
    };
    if spans.is_empty() {
        return gpui_kit::StyledText::new(" ");
    }
    let mut text = String::new();
    let mut runs = Vec::with_capacity(spans.len());
    for span in spans {
        let start = text.len();
        text.push_str(&span.text);
        let end = text.len();
        if end > start {
            let mut style = gpui_kit::HighlightStyle {
                color: Some(to_hsla(span.color)),
                ..Default::default()
            };
            if span.bold {
                style.font_weight = Some(FontWeight::BOLD);
            }
            if span.italic {
                style.font_style = Some(gpui_kit::FontStyle::Italic);
            }
            runs.push((start..end, style));
        }
    }
    if text.is_empty() {
        return gpui_kit::StyledText::new(" ");
    }
    gpui_kit::StyledText::new(text).with_highlights(runs)
}

/// Queries `orchestration.getThreadProjection` to discover sorted ready checkpoint turn ordinals
/// for the scope dropdown and full-thread diff upper bound.
async fn resolve_checkpoint_turns(conn: &Connection, thread_id: &str) -> Result<Vec<i64>, String> {
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

    let mut ordinals: Vec<i64> = checkpoints
        .into_iter()
        .flatten()
        .filter(|cp| cp.get("status").and_then(Value::as_str) == Some("ready"))
        .filter_map(|cp| {
            cp.get("appRunOrdinal")
                .or_else(|| cp.get("turnCount"))
                .and_then(Value::as_i64)
        })
        .filter(|&n| n > 0)
        .collect();
    ordinals.sort_unstable();
    ordinals.dedup();
    Ok(ordinals)
}

/// Pairs unified hunk lines into `(left_index, right_index)` rows for side-by-side split diff:
/// context lines appear on both sides, while contiguous `Removed` + `Added` blocks align pairwise.
fn pair_split_diff_rows(lines: &[DiffLine]) -> Vec<(Option<usize>, Option<usize>)> {
    let mut rows = Vec::with_capacity(lines.len());
    let mut i = 0;
    while i < lines.len() {
        match lines[i].kind {
            DiffLineKind::Context => {
                rows.push((Some(i), Some(i)));
                i += 1;
            }
            DiffLineKind::Removed => {
                let rem_start = i;
                while i < lines.len() && lines[i].kind == DiffLineKind::Removed {
                    i += 1;
                }
                let rem_end = i;
                let add_start = i;
                while i < lines.len() && lines[i].kind == DiffLineKind::Added {
                    i += 1;
                }
                let add_end = i;
                let rem_len = rem_end - rem_start;
                let add_len = add_end - add_start;
                let count = rem_len.max(add_len);
                for offset in 0..count {
                    let left = (offset < rem_len).then_some(rem_start + offset);
                    let right = (offset < add_len).then_some(add_start + offset);
                    rows.push((left, right));
                }
            }
            DiffLineKind::Added => {
                rows.push((None, Some(i)));
                i += 1;
            }
        }
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pair_split_diff_rows_aligns_removed_and_added_blocks() {
        let lines = vec![
            DiffLine {
                kind: DiffLineKind::Context,
                old_line: Some(1),
                new_line: Some(1),
                text: "a".to_owned(),
            },
            DiffLine {
                kind: DiffLineKind::Removed,
                old_line: Some(2),
                new_line: None,
                text: "old1".to_owned(),
            },
            DiffLine {
                kind: DiffLineKind::Removed,
                old_line: Some(3),
                new_line: None,
                text: "old2".to_owned(),
            },
            DiffLine {
                kind: DiffLineKind::Added,
                old_line: None,
                new_line: Some(2),
                text: "new1".to_owned(),
            },
            DiffLine {
                kind: DiffLineKind::Context,
                old_line: Some(4),
                new_line: Some(3),
                text: "b".to_owned(),
            },
            DiffLine {
                kind: DiffLineKind::Added,
                old_line: None,
                new_line: Some(4),
                text: "new2".to_owned(),
            },
        ];
        assert_eq!(
            pair_split_diff_rows(&lines),
            vec![
                (Some(0), Some(0)),
                (Some(1), Some(3)),
                (Some(2), None),
                (Some(4), Some(4)),
                (None, Some(5)),
            ]
        );
    }
}
