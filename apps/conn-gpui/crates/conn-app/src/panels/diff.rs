//! Diff right-panel surface: Conn toolbar (scope pill, `DiffStatLabel`, `ToolbarGroup`),
//! toggleable Pierre-themed changed-files list, and unified diff viewer with Conn's
//! gutter tints and clean T-junction split.

use std::fmt;

use conn_client::Connection;
use conn_contract::rpc::orchestration::{get_full_thread_diff, get_turn_diff};
use conn_contract::{
    OrchestrationGetFullThreadDiffInput, OrchestrationGetTurnDiffInput, ReviewBranchCommitsInput,
    ReviewBranchCommitsResult, ReviewBranchCommitsResultCommitsItem, ReviewDiffPreviewInput,
    ReviewDiffPreviewInputSourceKind, ReviewDiffPreviewResult, ReviewDiffPreviewSourceKind,
    VcsListRefsInput, VcsListRefsResult,
};
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
use crate::a11y::ConnA11yExt as _;

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

#[derive(Clone, Debug, Default, PartialEq, Eq)]
enum DiffScope {
    /// Branch diff against automatic or chosen base ref (`review.getDiffPreview` `branch-range`).
    #[default]
    Branch,
    /// Uncommitted working-tree diff (`review.getDiffPreview` `working-tree`).
    WorkingTree,
    /// Single branch commit diff (`review.getDiffPreview` with `commitSha`).
    Commit { sha: String, subject: String },
    /// Full thread checkpoint diff (`orchestration.getFullThreadDiff`).
    AllChanges,
    /// Single turn checkpoint diff (`orchestration.getTurnDiff`).
    Turn { from: i64, to: i64 },
}

impl DiffScope {
    fn label(&self) -> String {
        match self {
            Self::Branch => "Changes".to_owned(),
            Self::WorkingTree => "Uncommitted".to_owned(),
            Self::Commit { sha, subject } => {
                if subject.trim().is_empty() {
                    format!("Commit {}", &sha[..sha.len().min(7)])
                } else {
                    subject.chars().take(28).collect()
                }
            }
            Self::AllChanges => "All turns".to_owned(),
            Self::Turn { to, .. } => format!("Turn {to}"),
        }
    }

    fn is_git_scope(&self) -> bool {
        matches!(self, Self::Branch | Self::WorkingTree | Self::Commit { .. })
    }
}

/// Thread & git diff panel displaying changed files on the left and unified or split diff hunks on the right.
pub(crate) struct DiffPanel {
    tokens: Tokens,
    connection: Option<Connection>,
    workspace_root: Option<String>,
    thread_id: Option<String>,
    turn_count: Option<i64>,
    available_turns: Vec<i64>,
    branch_commits: Vec<ReviewBranchCommitsResultCommitsItem>,
    available_refs: Vec<String>,
    base_ref: Option<String>,
    resolved_base_ref: Option<String>,
    resolved_head_ref: Option<String>,
    scope: DiffScope,
    scope_menu_open: bool,
    base_ref_menu_open: bool,
    ignore_whitespace: bool,
    state: DiffLoadState,
    selected_index: usize,
    view_mode: DiffViewMode,
    word_wrap: bool,
    file_tree_open: bool,
    file_list_width: f32,
    split_drag: Option<(f32, f32)>,
    generation: u64,
    /// True while this surface is the visible right-panel tab. Hidden, it loads nothing.
    active: bool,
    /// A reload was skipped while hidden; reload when shown.
    stale: bool,
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
            workspace_root: None,
            thread_id: None,
            turn_count: None,
            available_turns: Vec::new(),
            branch_commits: Vec::new(),
            available_refs: Vec::new(),
            base_ref: None,
            resolved_base_ref: None,
            resolved_head_ref: None,
            scope: DiffScope::Branch,
            scope_menu_open: false,
            base_ref_menu_open: false,
            ignore_whitespace: false,
            state: DiffLoadState::Empty,
            selected_index: 0,
            view_mode: DiffViewMode::Unified,
            word_wrap: false,
            file_tree_open: true,
            file_list_width: FILE_LIST_WIDTH_PX,
            split_drag: None,
            generation: 0,
            active: false,
            stale: false,
        }
    }

    pub(crate) fn set_connection(
        &mut self,
        connection: Option<Connection>,
        cx: &mut Context<'_, Self>,
    ) {
        self.connection = connection;
        self.generation = self.generation.wrapping_add(1);
        self.state = DiffLoadState::Empty;
        self.branch_commits.clear();
        self.available_refs.clear();
        self.resolved_base_ref = None;
        self.resolved_head_ref = None;
        self.selected_index = 0;
        cx.notify();
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
        self.branch_commits.clear();
        self.available_refs.clear();
        self.base_ref = None;
        self.resolved_base_ref = None;
        self.resolved_head_ref = None;
        self.scope_menu_open = false;
        self.base_ref_menu_open = false;
        if self.workspace_root.is_some() || self.thread_id.is_some() {
            self.reload(cx);
        } else {
            self.state = DiffLoadState::Empty;
            cx.notify();
        }
    }

    pub(crate) fn set_thread(&mut self, thread_id: Option<String>, cx: &mut Context<'_, Self>) {
        if self.thread_id == thread_id {
            return;
        }
        self.thread_id = thread_id;
        self.turn_count = None;
        self.available_turns.clear();
        self.scope = if self.workspace_root.is_some() {
            DiffScope::Branch
        } else {
            DiffScope::AllChanges
        };
        self.scope_menu_open = false;
        self.base_ref_menu_open = false;
        self.selected_index = 0;
        self.reload(cx);
    }

    pub(crate) fn set_turn_count(&mut self, turn_count: Option<i64>, cx: &mut Context<'_, Self>) {
        if self.turn_count == turn_count {
            return;
        }
        self.turn_count = turn_count;
        if self.thread_id.is_some() || self.workspace_root.is_some() {
            self.reload(cx);
        }
    }

    fn load_refs_if_needed(&mut self, cx: &mut Context<'_, Self>) {
        let (Some(conn), Some(cwd)) = (self.connection.clone(), self.workspace_root.clone()) else {
            return;
        };
        let generation = self.generation;
        cx.spawn(async move |this, cx| {
            let input = VcsListRefsInput {
                cwd,
                query: None,
                cursor: None,
                include_matching_remote_refs: Some(true),
                ref_kind: None,
                refresh: None,
                limit: Some(60),
            };
            let result = conn
                .call::<VcsListRefsInput, VcsListRefsResult>("vcs.listRefs", &input)
                .await;
            if let Ok(resp) = result {
                let names: Vec<String> = resp.refs.into_iter().map(|r| r.name).collect();
                let _ = this.update(cx, |panel, cx| {
                    if panel.generation == generation {
                        panel.available_refs = names;
                        cx.notify();
                    }
                });
            }
        })
        .detach();
    }

    /// Shows or hides this surface. A reload skipped while hidden runs on show, as Conn mounts
    /// the diff panel (and runs its git and checkpoint queries) only while its tab is visible.
    pub(crate) fn set_active(&mut self, active: bool, cx: &mut Context<'_, Self>) {
        if self.active == active {
            return;
        }
        self.active = active;
        if active && self.stale {
            self.reload(cx);
        }
    }

    pub(crate) fn reload(&mut self, cx: &mut Context<'_, Self>) {
        self.generation = self.generation.wrapping_add(1);
        let generation = self.generation;
        if !self.active {
            self.stale = true;
            return;
        }
        self.stale = false;

        let Some(conn) = self.connection.clone() else {
            self.state = DiffLoadState::Error("Not connected to server.".to_owned());
            cx.notify();
            return;
        };
        if self.thread_id.is_none() && self.workspace_root.is_none() {
            self.state = DiffLoadState::Empty;
            cx.notify();
            return;
        }

        let thread_id = self.thread_id.clone();
        let workspace_root = self.workspace_root.clone();
        let explicit_turns = self.turn_count;
        let base_ref = self.base_ref.clone();
        let ignore_whitespace = self.ignore_whitespace;
        let scope = if workspace_root.is_none() && self.scope.is_git_scope() {
            DiffScope::AllChanges
        } else {
            self.scope.clone()
        };
        self.state = DiffLoadState::Loading;
        cx.notify();

        cx.spawn(async move |this, cx| {
            let discovered_turns = match &thread_id {
                Some(tid) => resolve_checkpoint_turns(&conn, tid).await,
                None => Ok(Vec::new()),
            };
            let turns_for_ui = discovered_turns.as_ref().cloned().unwrap_or_default();

            let commits_for_ui = match &workspace_root {
                Some(cwd) => {
                    let input = ReviewBranchCommitsInput {
                        cwd: cwd.clone(),
                        base_ref: base_ref.clone(),
                    };
                    conn.call::<ReviewBranchCommitsInput, ReviewBranchCommitsResult>(
                        "review.getBranchCommits",
                        &input,
                    )
                    .await
                    .map(|r| r.commits)
                    .unwrap_or_default()
                }
                None => Vec::new(),
            };

            let mut resolved_base: Option<String> = None;
            let mut resolved_head: Option<String> = None;

            let result = match scope {
                DiffScope::Branch | DiffScope::WorkingTree | DiffScope::Commit { .. } => {
                    match workspace_root {
                        None => Ok(Vec::new()),
                        Some(cwd) => {
                            let (source_kind, commit_sha, wanted_kind) = match &scope {
                                DiffScope::WorkingTree => (
                                    Some(ReviewDiffPreviewInputSourceKind::WorkingTree),
                                    None,
                                    ReviewDiffPreviewSourceKind::WorkingTree,
                                ),
                                DiffScope::Commit { sha, .. } => (
                                    None,
                                    Some(sha.clone()),
                                    ReviewDiffPreviewSourceKind::Commit,
                                ),
                                _ => (
                                    Some(ReviewDiffPreviewInputSourceKind::BranchRange),
                                    None,
                                    ReviewDiffPreviewSourceKind::BranchRange,
                                ),
                            };
                            let input = ReviewDiffPreviewInput {
                                cwd,
                                base_ref: if matches!(scope, DiffScope::WorkingTree) {
                                    None
                                } else {
                                    base_ref
                                },
                                commit_sha,
                                ignore_whitespace: Some(ignore_whitespace),
                                source_kind,
                                tracked_only: None,
                                metadata_only: None,
                                file: None,
                            };
                            match conn
                                .call::<ReviewDiffPreviewInput, ReviewDiffPreviewResult>(
                                    "review.getDiffPreview",
                                    &input,
                                )
                                .await
                            {
                                Ok(preview) => {
                                    let matched = preview
                                        .sources
                                        .iter()
                                        .find(|s| s.kind == wanted_kind)
                                        .or_else(|| preview.sources.first());
                                    if let Some(src) = matched {
                                        resolved_base = src.base_ref.clone();
                                        resolved_head = src.head_ref.clone();
                                        Ok(parse_unified_diff(&src.diff))
                                    } else {
                                        Ok(Vec::new())
                                    }
                                }
                                Err(err) => Err(err.to_string()),
                            }
                        }
                    }
                }
                DiffScope::AllChanges => match thread_id {
                    None => Ok(Vec::new()),
                    Some(thread_id) => {
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
                                    ignore_whitespace: Some(ignore_whitespace),
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
                },
                DiffScope::Turn { from, to } => match thread_id {
                    None => Ok(Vec::new()),
                    Some(thread_id) => {
                        let payload = OrchestrationGetTurnDiffInput {
                            from_turn_count: from,
                            to_turn_count: to,
                            thread_id,
                            ignore_whitespace: Some(ignore_whitespace),
                        };
                        conn.call::<get_turn_diff::Payload, get_turn_diff::Success>(
                            "orchestration.getTurnDiff",
                            &payload,
                        )
                        .await
                        .map(|resp| parse_unified_diff(&resp.diff))
                        .map_err(|e| e.to_string())
                    }
                },
            };

            let _ = this.update(cx, |panel, cx| {
                if panel.generation != generation {
                    return;
                }
                if !turns_for_ui.is_empty() {
                    panel.available_turns = turns_for_ui;
                }
                panel.branch_commits = commits_for_ui;
                panel.resolved_base_ref = resolved_base;
                panel.resolved_head_ref = resolved_head;
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

        let has_git = self.workspace_root.is_some();
        let has_turns = !self.available_turns.is_empty();
        let can_pick_scope = has_git || has_turns;
        let scope_label = self.scope.label();
        let mut scope_slot = div().relative().child(
            // Scope trigger pill matching `DiffPanel.tsx` (`size="xs" variant="secondary"`, 6px radius).
            h_flex()
                .id("diff-scope-trigger")
                .a11y_button("diff.scope.trigger", format!("Diff scope: {scope_label}"))
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
                .when(can_pick_scope, |el| {
                    el.cursor_pointer()
                        .hover(move |s| s.bg(hover_bg))
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _, _, cx| {
                                cx.stop_propagation();
                                this.base_ref_menu_open = false;
                                this.scope_menu_open = !this.scope_menu_open;
                                cx.notify();
                            }),
                        )
                })
                .child(scope_label)
                .when(can_pick_scope, |el| {
                    el.child(superhero_icon("superhero/chevron-down.svg", 12.0, muted))
                }),
        );
        if self.scope_menu_open && can_pick_scope {
            let pop_bg = to_hsla(self.tokens.popover);
            let pop_fg = to_hsla(self.tokens.popover_foreground);
            let pop_border = to_hsla(self.tokens.shell_inner_border);
            let pop_div = to_hsla(self.tokens.glass_divider);
            let mut menu = v_flex()
                .id("diff-scope-menu")
                .absolute()
                .top_full()
                .left_0()
                .mt(px(4.0))
                .w(px(248.0))
                .max_h(px(320.0))
                .overflow_y_scroll()
                .rounded(px(10.0))
                .bg(pop_bg)
                .border_1()
                .border_color(pop_border)
                .shadow_md()
                .p(px(4.0))
                .gap(px(2.0))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation());

            if has_git {
                for (id, label, icon, target) in [
                    (
                        "diff-scope-branch",
                        "Changes (branch)",
                        "superhero/branch.svg",
                        DiffScope::Branch,
                    ),
                    (
                        "diff-scope-working-tree",
                        "Uncommitted",
                        "superhero/git-controls.svg",
                        DiffScope::WorkingTree,
                    ),
                ] {
                    let selected = self.scope == target;
                    menu = menu.child(
                        h_flex()
                            .id(id)
                            .a11y_button(SharedString::from(format!("diff.scope.{id}")), label)
                            .h(px(26.0))
                            .px(px(8.0))
                            .gap(px(6.0))
                            .items_center()
                            .rounded(px(6.0))
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
                                        this.scope = target.clone();
                                        this.reload(cx);
                                    } else {
                                        cx.notify();
                                    }
                                }),
                            )
                            .child(superhero_icon(
                                icon,
                                13.0,
                                if selected { pop_fg } else { muted },
                            ))
                            .child(div().flex_1().truncate().child(label))
                            .when(selected, |el| {
                                el.child(superhero_icon("superhero/check.svg", 13.0, pop_fg))
                            }),
                    );
                }

                if !self.branch_commits.is_empty() {
                    menu = menu
                        .child(div().my(px(3.0)).h(px(1.0)).w_full().bg(pop_div))
                        .child(
                            div()
                                .px(px(8.0))
                                .py(px(2.0))
                                .text_size(px(11.0))
                                .text_color(muted)
                                .child("Commits"),
                        );
                    for commit in self.branch_commits.iter().take(12) {
                        let short_sha = &commit.sha[..commit.sha.len().min(7)];
                        let target = DiffScope::Commit {
                            sha: commit.sha.clone(),
                            subject: commit.subject.clone(),
                        };
                        let selected = self.scope == target;
                        let title = if commit.subject.trim().is_empty() {
                            short_sha.to_owned()
                        } else {
                            commit.subject.clone()
                        };
                        menu = menu.child(
                            h_flex()
                                .id(SharedString::from(format!("diff-scope-commit-{short_sha}")))
                                .h(px(26.0))
                                .px(px(8.0))
                                .gap(px(6.0))
                                .items_center()
                                .rounded(px(6.0))
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
                                            this.scope = target.clone();
                                            this.reload(cx);
                                        } else {
                                            cx.notify();
                                        }
                                    }),
                                )
                                .child(superhero_icon(
                                    "superhero/commit.svg",
                                    12.0,
                                    if selected { pop_fg } else { muted },
                                ))
                                .child(div().flex_1().min_w_0().truncate().child(title))
                                .child(
                                    div()
                                        .flex_shrink_0()
                                        .text_size(px(11.0))
                                        .text_color(muted)
                                        .child(short_sha.to_owned()),
                                )
                                .when(selected, |el| {
                                    el.child(superhero_icon("superhero/check.svg", 13.0, pop_fg))
                                }),
                        );
                    }
                }
            }

            if has_turns {
                if has_git {
                    menu = menu
                        .child(div().my(px(3.0)).h(px(1.0)).w_full().bg(pop_div))
                        .child(
                            div()
                                .px(px(8.0))
                                .py(px(2.0))
                                .text_size(px(11.0))
                                .text_color(muted)
                                .child("Thread turns"),
                        );
                }
                let all_selected = self.scope == DiffScope::AllChanges;
                menu = menu.child(
                    h_flex()
                        .id("diff-scope-all")
                        .h(px(26.0))
                        .px(px(8.0))
                        .gap(px(6.0))
                        .items_center()
                        .rounded(px(6.0))
                        .cursor_pointer()
                        .text_size(px(UI_TEXT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .text_color(if all_selected { pop_fg } else { muted })
                        .hover(move |s| s.bg(hover_bg).text_color(pop_fg))
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
                        .child(div().flex_1().child("All turns"))
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
                            .rounded(px(6.0))
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
                                        this.scope = target.clone();
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
            }
            scope_slot = scope_slot.child(deferred(menu).with_priority(3));
        }

        // Base ref comparison switcher (`main -> feat/foo`) shown for Branch scope.
        let base_ref_slot = (has_git && self.scope == DiffScope::Branch).then(|| {
            let base_label = self
                .resolved_base_ref
                .as_deref()
                .or(self.base_ref.as_deref())
                .unwrap_or("Automatic");
            let head_label = self.resolved_head_ref.as_deref().unwrap_or("HEAD");
            let mut slot = div().relative().child(
                h_flex()
                    .id("diff-base-ref-trigger")
                    .a11y_button(
                        "diff.base-ref.trigger",
                        format!("Compare base {base_label} to {head_label}"),
                    )
                    .h(px(28.0))
                    .px(px(8.0))
                    .gap(px(4.0))
                    .items_center()
                    .rounded(px(CONTROL_RADIUS_PX))
                    .bg(control_bg)
                    .border_1()
                    .border_color(control_border)
                    .text_size(px(12.0))
                    .text_color(muted)
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover_bg).text_color(fg))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, _, _, cx| {
                            cx.stop_propagation();
                            this.scope_menu_open = false;
                            this.base_ref_menu_open = !this.base_ref_menu_open;
                            if this.base_ref_menu_open {
                                this.load_refs_if_needed(cx);
                            }
                            cx.notify();
                        }),
                    )
                    .child(base_label.to_owned())
                    .child(superhero_icon("superhero/arrow-right.svg", 11.0, muted))
                    .child(div().text_color(fg).child(head_label.to_owned())),
            );
            if self.base_ref_menu_open {
                let pop_bg = to_hsla(self.tokens.popover);
                let pop_fg = to_hsla(self.tokens.popover_foreground);
                let pop_border = to_hsla(self.tokens.shell_inner_border);
                let mut menu = v_flex()
                    .id("diff-base-ref-menu")
                    .absolute()
                    .top_full()
                    .left_0()
                    .mt(px(4.0))
                    .w(px(210.0))
                    .max_h(px(260.0))
                    .overflow_y_scroll()
                    .rounded(px(10.0))
                    .bg(pop_bg)
                    .border_1()
                    .border_color(pop_border)
                    .shadow_md()
                    .p(px(4.0))
                    .gap(px(2.0))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation());

                let auto_selected = self.base_ref.is_none();
                menu = menu.child(
                    h_flex()
                        .id("diff-base-ref-auto")
                        .h(px(26.0))
                        .px(px(8.0))
                        .gap(px(6.0))
                        .items_center()
                        .rounded(px(6.0))
                        .cursor_pointer()
                        .text_size(px(UI_TEXT_PX))
                        .text_color(if auto_selected { pop_fg } else { muted })
                        .hover(move |s| s.bg(hover_bg).text_color(pop_fg))
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _, _, cx| {
                                cx.stop_propagation();
                                this.base_ref_menu_open = false;
                                if this.base_ref.take().is_some() {
                                    this.reload(cx);
                                } else {
                                    cx.notify();
                                }
                            }),
                        )
                        .child(div().flex_1().child("Automatic"))
                        .when(auto_selected, |el| {
                            el.child(superhero_icon("superhero/check.svg", 13.0, pop_fg))
                        }),
                );

                for ref_name in &self.available_refs {
                    let selected = self.base_ref.as_deref() == Some(ref_name.as_str());
                    let chosen = ref_name.clone();
                    menu = menu.child(
                        h_flex()
                            .id(SharedString::from(format!("diff-base-ref-{ref_name}")))
                            .h(px(26.0))
                            .px(px(8.0))
                            .gap(px(6.0))
                            .items_center()
                            .rounded(px(6.0))
                            .cursor_pointer()
                            .text_size(px(UI_TEXT_PX))
                            .text_color(if selected { pop_fg } else { muted })
                            .hover(move |s| s.bg(hover_bg).text_color(pop_fg))
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(move |this, _, _, cx| {
                                    cx.stop_propagation();
                                    this.base_ref_menu_open = false;
                                    if this.base_ref.as_deref() != Some(chosen.as_str()) {
                                        this.base_ref = Some(chosen.clone());
                                        this.reload(cx);
                                    } else {
                                        cx.notify();
                                    }
                                }),
                            )
                            .child(div().flex_1().truncate().child(ref_name.clone()))
                            .when(selected, |el| {
                                el.child(superhero_icon("superhero/check.svg", 13.0, pop_fg))
                            }),
                    );
                }
                slot = slot.child(deferred(menu).with_priority(3));
            }
            slot
        });

        let whitespace_color = if self.ignore_whitespace { fg } else { muted };

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
                    .min_w_0()
                    .items_center()
                    .gap(px(6.0))
                    .child(scope_slot)
                    .when_some(base_ref_slot, |el, slot| el.child(slot))
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
                                    .a11y_button("diff.refresh", "Refresh diff")
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
                                    .id("diff-whitespace-btn")
                                    .a11y_button("diff.whitespace", "Ignore whitespace")
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
                                            this.ignore_whitespace = !this.ignore_whitespace;
                                            this.reload(cx);
                                        }),
                                    )
                                    .conn_tooltip(
                                        if self.ignore_whitespace {
                                            "Show whitespace changes"
                                        } else {
                                            "Ignore whitespace"
                                        },
                                        &self.tokens,
                                    )
                                    .child(superhero_icon(
                                        "superhero/whitespace.svg",
                                        14.0,
                                        whitespace_color,
                                    )),
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
                    if this.scope_menu_open || this.base_ref_menu_open {
                        this.scope_menu_open = false;
                        this.base_ref_menu_open = false;
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

    #[test]
    fn diff_scope_labels_and_git_classification_match_conn() {
        assert_eq!(DiffScope::Branch.label(), "Changes");
        assert!(DiffScope::Branch.is_git_scope());
        assert_eq!(DiffScope::WorkingTree.label(), "Uncommitted");
        assert!(DiffScope::WorkingTree.is_git_scope());
        assert_eq!(
            DiffScope::Commit {
                sha: "abcdef123456".to_owned(),
                subject: String::new(),
            }
            .label(),
            "Commit abcdef1"
        );
        assert_eq!(
            DiffScope::Commit {
                sha: "abcdef123456".to_owned(),
                subject: "feat(diff): add scopes".to_owned(),
            }
            .label(),
            "feat(diff): add scopes"
        );
        assert!(!DiffScope::AllChanges.is_git_scope());
        assert_eq!(DiffScope::AllChanges.label(), "All turns");
        assert_eq!(DiffScope::Turn { from: 1, to: 2 }.label(), "Turn 2");
    }
}
