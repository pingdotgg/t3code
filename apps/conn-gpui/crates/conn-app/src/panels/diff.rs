//! Diff right-panel surface: Conn toolbar (scope pill, `DiffStatLabel`, `ToolbarGroup`),
//! toggleable Pierre-themed changed-files list, and one continuous multi-file diff with
//! sticky file headers, Conn's gutter tints and clean T-junction split.
//!
//! Every changed file is flattened into rows of one virtualized `ListState`, so only rows near
//! the viewport are built. GPUI has no `position: sticky`; the current file's header is drawn as
//! an overlay from the list's scroll offset and pushed up by the next file's header.

use std::collections::HashMap;
use std::fmt;
use std::hash::{Hash, Hasher};
use std::rc::Rc;

use conn_client::Connection;
use conn_contract::rpc::orchestration::{get_full_thread_diff, get_turn_diff};
use conn_contract::{
    OrchestrationGetFullThreadDiffInput, OrchestrationGetTurnDiffInput, ReviewBranchCommitsInput,
    ReviewBranchCommitsResult, ReviewBranchCommitsResultCommitsItem, ReviewDiffPreviewInput,
    ReviewDiffPreviewInputSourceKind, ReviewDiffPreviewResult, ReviewDiffPreviewSourceKind,
    VcsListRefsInput, VcsListRefsResult,
};
use conn_theme::{Appearance, Tokens, color_mix_srgb};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::{ActiveTheme as _, h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, Context, CursorStyle, FontWeight, Hsla, InteractiveElement, IntoElement,
    ListAlignment, ListOffset, ListState, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, ParentElement, Render, SharedString, Styled, Window, deferred, div, list, px,
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
/// File header height, border included. The sticky overlay and the in-list header share it.
const FILE_HEADER_HEIGHT_PX: f32 = 32.0;
/// Space under each file's last line. Its bottom edge is the 1px line before the next header.
const FILE_END_GAP_PX: f32 = 12.0;
/// Space under the last file so its final line is not flush with the panel edge.
const LIST_TAIL_PX: f32 = 24.0;
/// Rows built past the viewport on each side.
const LIST_OVERDRAW_PX: f32 = 480.0;

#[derive(Clone, Debug)]
enum DiffLoadState {
    Empty,
    Loading,
    Loaded(Rc<[DiffFile]>),
    Error(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NoticeKind {
    Binary,
    NoLines,
}

/// One virtualized row of the continuous diff. Rows hold indices into the loaded files.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DiffRow {
    Header {
        file: usize,
    },
    Notice {
        file: usize,
        kind: NoticeKind,
    },
    Hunk {
        file: usize,
        hunk: usize,
    },
    Line {
        file: usize,
        hunk: usize,
        line: usize,
    },
    Split {
        file: usize,
        hunk: usize,
        left: Option<usize>,
        right: Option<usize>,
    },
    FileEnd {
        file: usize,
    },
    Tail,
}

/// Syntax spans of one file, computed when its first row is built.
struct FileHighlight {
    lines: Vec<Vec<HighlightSpan>>,
    /// Index of each hunk's first line in `lines`.
    hunk_base: Vec<usize>,
}

/// Diff row and gutter colors derived from the theme (`lib/diffRendering.ts`).
#[derive(Clone, Copy)]
struct DiffPalette {
    code_fg: Hsla,
    ui_fg: Hsla,
    muted: Hsla,
    gutter_fg: Hsla,
    divider: Hsla,
    added: Hsla,
    removed: Hsla,
    added_bg: Hsla,
    added_gutter_bg: Hsla,
    removed_bg: Hsla,
    removed_gutter_bg: Hsla,
    separator_bg: Hsla,
    card_bg: Hsla,
}

impl DiffPalette {
    fn new(tokens: &Tokens) -> Self {
        // Conn derives diff row & gutter backgrounds from `--code-background`, re-rooted to
        // `--shell-card` in the right panel.
        let code_bg = tokens.shell_card;
        let is_dark = tokens.appearance == Appearance::Dark;
        let line_weight = if is_dark { 0.70 } else { 0.50 };
        let gutter_weight = if is_dark { 0.60 } else { 0.35 };
        Self {
            code_fg: to_hsla(tokens.code_foreground),
            ui_fg: to_hsla(tokens.foreground),
            muted: to_hsla(tokens.muted_foreground),
            gutter_fg: to_hsla(tokens.muted_foreground.with_alpha(0.65)),
            divider: to_hsla(tokens.shell_divider),
            added: to_hsla(tokens.diff_added),
            removed: to_hsla(tokens.diff_removed),
            added_bg: to_hsla(color_mix_srgb(
                code_bg,
                line_weight,
                tokens.diff_added_background,
            )),
            added_gutter_bg: to_hsla(color_mix_srgb(
                code_bg,
                gutter_weight,
                tokens.diff_added_background,
            )),
            removed_bg: to_hsla(color_mix_srgb(
                code_bg,
                line_weight,
                tokens.diff_removed_background,
            )),
            removed_gutter_bg: to_hsla(color_mix_srgb(
                code_bg,
                gutter_weight,
                tokens.diff_removed_background,
            )),
            separator_bg: to_hsla(color_mix_srgb(code_bg, 0.95, tokens.code_foreground)),
            card_bg: to_hsla(code_bg),
        }
    }
}

/// Flattens files into list rows and returns each file's header row index.
fn build_rows(files: &[DiffFile], mode: DiffViewMode) -> (Vec<DiffRow>, Vec<usize>) {
    let mut rows = Vec::new();
    let mut starts = Vec::with_capacity(files.len());
    for (file_idx, file) in files.iter().enumerate() {
        starts.push(rows.len());
        rows.push(DiffRow::Header { file: file_idx });
        if file.is_binary {
            rows.push(DiffRow::Notice {
                file: file_idx,
                kind: NoticeKind::Binary,
            });
        } else if file.hunks.is_empty() {
            rows.push(DiffRow::Notice {
                file: file_idx,
                kind: NoticeKind::NoLines,
            });
        } else {
            for (hunk_idx, hunk) in file.hunks.iter().enumerate() {
                rows.push(DiffRow::Hunk {
                    file: file_idx,
                    hunk: hunk_idx,
                });
                match mode {
                    DiffViewMode::Split => {
                        for (left, right) in pair_split_diff_rows(&hunk.lines) {
                            rows.push(DiffRow::Split {
                                file: file_idx,
                                hunk: hunk_idx,
                                left,
                                right,
                            });
                        }
                    }
                    DiffViewMode::Unified => {
                        for line in 0..hunk.lines.len() {
                            rows.push(DiffRow::Line {
                                file: file_idx,
                                hunk: hunk_idx,
                                line,
                            });
                        }
                    }
                }
            }
        }
        rows.push(DiffRow::FileEnd { file: file_idx });
    }
    if !files.is_empty() {
        rows.push(DiffRow::Tail);
    }
    (rows, starts)
}

/// The file whose section contains `row`. Rows past the end belong to the last file.
fn file_for_row(file_starts: &[usize], row: usize) -> usize {
    file_starts
        .partition_point(|&start| start <= row)
        .saturating_sub(1)
}

/// How far the sticky header moves up (zero or negative) while the next file's header, whose top
/// sits `next_header_top` px under the viewport top, pushes it out.
fn sticky_push(next_header_top: f32) -> f32 {
    (next_header_top - FILE_HEADER_HEIGHT_PX).min(0.0)
}

/// A request from the timeline to show one turn's diff, optionally on one file.
#[derive(Clone, Debug, PartialEq, Eq)]
struct DiffFocus {
    /// Checkpoint ordinal of the turn; `None` shows every turn.
    turn: Option<i64>,
    file: Option<String>,
}

/// The scope that diffs turn `to` against the turn before it, as the scope menu lists it:
/// the previous ready checkpoint when known, else the one just before `to`.
fn turn_scope(to: i64, available_turns: &[i64]) -> DiffScope {
    let from = if available_turns.is_empty() {
        (to - 1).max(0)
    } else {
        available_turns
            .iter()
            .copied()
            .filter(|&turn| turn < to)
            .max()
            .unwrap_or(0)
    };
    DiffScope::Turn { from, to }
}

/// The scope a load runs with once it has the thread's refreshed checkpoints. A turn diffs
/// against the checkpoint before it in that list (web's `fromTurnCount`), never against the
/// panel's cached one, which misses turns that finished since the panel last loaded.
fn request_scope(scope: &DiffScope, fresh_turns: &[i64]) -> DiffScope {
    match scope {
        DiffScope::Turn { to, .. } if !fresh_turns.is_empty() => turn_scope(*to, fresh_turns),
        other => other.clone(),
    }
}

/// Index of the file a chat path points at. The path is workspace-relative, but one that
/// carries a leading `./` or extra directories still matches by its trailing segments.
fn find_file_for_path(files: &[DiffFile], path: &str) -> Option<usize> {
    let wanted = path.trim().trim_start_matches("./");
    if wanted.is_empty() {
        return None;
    }
    fn paths(file: &DiffFile) -> impl Iterator<Item = &str> {
        [file.new_path.as_deref(), file.old_path.as_deref()]
            .into_iter()
            .flatten()
    }
    // An exact path wins: `package.json` is the root file even after `apps/web/package.json`.
    let exact = files.iter().position(|file| {
        paths(file).any(|candidate| candidate == wanted) || file.display_path == wanted
    });
    exact.or_else(|| {
        files.iter().position(|file| {
            paths(file).any(|candidate| {
                candidate.ends_with(&format!("/{wanted}"))
                    || wanted.ends_with(&format!("/{candidate}"))
            })
        })
    })
}

/// Identity of the diff a viewed mark belongs to. Marks survive a refresh of the same scope and
/// base branch, and come back when the reader returns to that scope.
fn viewed_scope_key(scope: &DiffScope, base_ref: Option<&str>) -> String {
    match scope {
        DiffScope::Branch => format!("branch:{}", base_ref.unwrap_or("auto")),
        other => format!("{other:?}"),
    }
}

/// Hash of a file's diff content. A viewed mark holds only while the fingerprint is unchanged.
fn file_fingerprint(file: &DiffFile) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    file.is_binary.hash(&mut hasher);
    // The blob hashes change with the content, also where no line does (binaries, mode-only).
    file.index.hash(&mut hasher);
    for hunk in &file.hunks {
        hunk.header.hash(&mut hasher);
        for line in &hunk.lines {
            let kind: u8 = match line.kind {
                DiffLineKind::Context => 0,
                DiffLineKind::Added => 1,
                DiffLineKind::Removed => 2,
            };
            kind.hash(&mut hasher);
            line.text.hash(&mut hasher);
        }
    }
    hasher.finish()
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
    available_turns: Vec<i64>,
    /// A turn request that arrived before the panel had its thread.
    pending_focus: Option<DiffFocus>,
    /// File to select and scroll to when the next load finishes.
    pending_reveal: Option<String>,
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
    /// Viewed marks per diff scope (`viewed_scope_key`): display path to the file's fingerprint
    /// when it was marked. A mark counts only while the file's diff is unchanged. Kept across
    /// refreshes and scope switches; cleared when the thread or workspace changes.
    viewed: HashMap<String, HashMap<String, u64>>,
    /// Scope key of the files now loaded; viewed marks read and write under it.
    loaded_scope_key: String,
    /// Fingerprint of each loaded file, parallel to the loaded files.
    fingerprints: Vec<u64>,
    /// The continuous diff, flattened into virtualized list rows.
    rows: Vec<DiffRow>,
    /// Header row index of each loaded file.
    file_starts: Vec<usize>,
    list_state: ListState,
    scroll_hooked: bool,
    palette: DiffPalette,
    /// Lazily computed syntax spans per file index.
    highlights: HashMap<usize, Rc<FileHighlight>>,
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
            .field("scope", &self.scope)
            .field("selected_index", &self.selected_index)
            .finish_non_exhaustive()
    }
}

impl DiffPanel {
    pub(crate) fn new(tokens: Tokens, connection: Option<Connection>) -> Self {
        Self {
            palette: DiffPalette::new(&tokens),
            tokens,
            connection,
            workspace_root: None,
            thread_id: None,
            available_turns: Vec::new(),
            pending_focus: None,
            pending_reveal: None,
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
            viewed: HashMap::new(),
            loaded_scope_key: String::new(),
            fingerprints: Vec::new(),
            rows: Vec::new(),
            file_starts: Vec::new(),
            list_state: ListState::new(0, ListAlignment::Top, px(LIST_OVERDRAW_PX)),
            scroll_hooked: false,
            highlights: HashMap::new(),
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
        self.rebuild_rows();
        self.highlights.clear();
        self.branch_commits.clear();
        self.available_refs.clear();
        self.resolved_base_ref = None;
        self.resolved_head_ref = None;
        self.selected_index = 0;
        cx.notify();
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.palette = DiffPalette::new(&tokens);
        self.tokens = tokens;
        self.highlights.clear();
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
        self.viewed.clear();
        self.loaded_scope_key.clear();
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
        self.viewed.clear();
        self.loaded_scope_key.clear();
        self.available_turns.clear();
        self.scope = if self.workspace_root.is_some() {
            DiffScope::Branch
        } else {
            DiffScope::AllChanges
        };
        self.scope_menu_open = false;
        self.base_ref_menu_open = false;
        self.selected_index = 0;
        self.pending_reveal = None;
        // A panel created by the click that asked for a turn gets its thread afterwards; the
        // request waits here so the scope reset above does not undo it.
        if self.thread_id.is_some()
            && let Some(focus) = self.pending_focus.take()
        {
            self.apply_focus(focus);
        }
        self.reload(cx);
    }

    /// Opens the diff of one turn (`to`, the checkpoint ordinal of its run), or the whole thread
    /// when the run has no ordinal, and reveals `file` once it loads. A panel not bound to its
    /// thread yet keeps the request until it is.
    pub(crate) fn open_turn_diff(
        &mut self,
        turn: Option<i64>,
        file: Option<String>,
        cx: &mut Context<'_, Self>,
    ) {
        let focus = DiffFocus { turn, file };
        if self.thread_id.is_some() {
            self.apply_focus(focus);
            self.reload(cx);
        } else {
            self.pending_focus = Some(focus);
        }
    }

    fn apply_focus(&mut self, focus: DiffFocus) {
        self.scope = match focus.turn {
            Some(to) => turn_scope(to, &self.available_turns),
            None => DiffScope::AllChanges,
        };
        self.pending_reveal = focus.file;
        self.scope_menu_open = false;
        self.base_ref_menu_open = false;
    }

    /// Scope label and the file still waiting to be revealed, for tests.
    #[cfg(test)]
    pub(crate) fn focus_state(&self) -> (String, Option<String>) {
        (self.scope.label(), self.pending_reveal.clone())
    }

    /// Shows freshly loaded files. `keep_selected` is the display path to stay on after a refresh.
    fn install_files(
        &mut self,
        files: Vec<DiffFile>,
        scope_key: String,
        keep_selected: Option<String>,
    ) {
        self.fingerprints = files.iter().map(file_fingerprint).collect();
        let revealed = self
            .pending_reveal
            .take()
            .and_then(|path| find_file_for_path(&files, &path));
        self.selected_index = revealed
            .or_else(|| {
                keep_selected
                    .and_then(|path| files.iter().position(|file| file.display_path == path))
            })
            .unwrap_or(0);
        self.loaded_scope_key = scope_key;
        self.highlights.clear();
        self.state = DiffLoadState::Loaded(Rc::from(files));
        self.rebuild_rows();
        if self.selected_index > 0 {
            self.scroll_to_file(self.selected_index);
        }
    }

    /// Rebuilds the list rows for the loaded files and view mode, and resets the list to the top.
    fn rebuild_rows(&mut self) {
        let (rows, starts) = match &self.state {
            DiffLoadState::Loaded(files) => build_rows(files, self.view_mode),
            _ => (Vec::new(), Vec::new()),
        };
        self.list_state
            .reset_with_uniform_height(rows.len(), px(UI_LINE_HEIGHT_PX));
        self.rows = rows;
        self.file_starts = starts;
    }

    fn scroll_to_file(&self, file: usize) {
        if let Some(&row) = self.file_starts.get(file) {
            self.list_state.scroll_to(ListOffset {
                item_ix: row,
                offset_in_item: px(0.0),
            });
        }
    }

    /// Selects a file in the tree and scrolls the continuous diff to its header.
    fn select_file(&mut self, file: usize, cx: &mut Context<'_, Self>) {
        self.selected_index = file;
        self.scroll_to_file(file);
        cx.notify();
    }

    /// The file whose section holds the top of the viewport.
    fn top_file(&self) -> Option<usize> {
        if self.file_starts.is_empty() {
            return None;
        }
        let top = self.list_state.logical_scroll_top();
        Some(file_for_row(&self.file_starts, top.item_ix))
    }

    /// Moves the tree selection to the file under the viewport top after the reader scrolls.
    fn sync_selection_with_scroll(&mut self) {
        let Some(mut file) = self.top_file() else {
            return;
        };
        // At the end the last short files cannot reach the top; keep a selection still in view.
        if self.list_state.is_scrolled_to_end() == Some(true)
            && self.selected_index >= file
            && self.selected_index < self.file_starts.len()
        {
            file = self.selected_index;
        }
        self.selected_index = file;
    }

    fn toggle_view_mode(&mut self, cx: &mut Context<'_, Self>) {
        let keep = self.top_file();
        self.view_mode = match self.view_mode {
            DiffViewMode::Unified => DiffViewMode::Split,
            DiffViewMode::Split => DiffViewMode::Unified,
        };
        self.rebuild_rows();
        if let Some(file) = keep {
            self.scroll_to_file(file);
        }
        cx.notify();
    }

    fn toggle_word_wrap(&mut self, cx: &mut Context<'_, Self>) {
        self.word_wrap = !self.word_wrap;
        // Wrapping changes row heights.
        self.list_state.remeasure();
        cx.notify();
    }

    fn is_viewed(&self, index: usize, file: &DiffFile) -> bool {
        self.viewed
            .get(&self.loaded_scope_key)
            .and_then(|marks| marks.get(&file.display_path))
            .zip(self.fingerprints.get(index))
            .is_some_and(|(marked, current)| marked == current)
    }

    fn toggle_viewed(&mut self, index: usize) {
        let DiffLoadState::Loaded(files) = &self.state else {
            return;
        };
        let (Some(file), Some(&fingerprint)) = (files.get(index), self.fingerprints.get(index))
        else {
            return;
        };
        let path = file.display_path.clone();
        let marks = self
            .viewed
            .entry(self.loaded_scope_key.clone())
            .or_default();
        if marks.get(&path) == Some(&fingerprint) {
            marks.remove(&path);
        } else {
            marks.insert(path, fingerprint);
        }
    }

    /// Syntax spans for one file, computed on first use so a long thread does not highlight
    /// files the reader never scrolls to.
    fn highlight_for(&mut self, index: usize, file: &DiffFile) -> Rc<FileHighlight> {
        if let Some(found) = self.highlights.get(&index) {
            return Rc::clone(found);
        }
        let mut source = String::new();
        let mut hunk_base = Vec::with_capacity(file.hunks.len());
        let mut count = 0usize;
        for hunk in &file.hunks {
            hunk_base.push(count);
            count += hunk.lines.len();
            for line in &hunk.lines {
                source.push_str(&line.text);
                source.push('\n');
            }
        }
        let lines = highlight_lines(&file.display_path, &source, &self.tokens);
        let highlight = Rc::new(FileHighlight { lines, hunk_base });
        self.highlights.insert(index, Rc::clone(&highlight));
        highlight
    }

    /// Wheel scrolling moves the sticky header and the tree selection, so the list reports it.
    fn ensure_scroll_handler(&mut self, cx: &mut Context<'_, Self>) {
        if self.scroll_hooked {
            return;
        }
        self.scroll_hooked = true;
        let weak = cx.weak_entity();
        self.list_state.set_scroll_handler(move |_, _, cx| {
            let weak = weak.clone();
            // GPUI holds the list borrow while it dispatches scroll callbacks; update after.
            cx.defer(move |cx| {
                let _ = weak.update(cx, |panel, cx| {
                    panel.sync_selection_with_scroll();
                    cx.notify();
                });
            });
        });
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
        let base_ref = self.base_ref.clone();
        let ignore_whitespace = self.ignore_whitespace;
        let scope = if workspace_root.is_none() && self.scope.is_git_scope() {
            DiffScope::AllChanges
        } else {
            self.scope.clone()
        };
        let loaded_scope_key = self.loaded_scope_key.clone();
        let selected_path = match &self.state {
            DiffLoadState::Loaded(files) => files
                .get(self.selected_index)
                .map(|file| file.display_path.clone()),
            _ => None,
        };
        self.state = DiffLoadState::Loading;
        cx.notify();

        cx.spawn(async move |this, cx| {
            let discovered_turns = match &thread_id {
                Some(tid) => resolve_checkpoint_turns(&conn, tid).await,
                None => Ok(Vec::new()),
            };
            let turns_for_ui = discovered_turns.as_ref().cloned().unwrap_or_default();
            let requested = scope;
            let scope = request_scope(&requested, &turns_for_ui);
            let scope_key = viewed_scope_key(&scope, base_ref.as_deref());
            // A refresh of the same scope keeps the reader on the same file.
            let keep_selected = selected_path.filter(|_| loaded_scope_key == scope_key);

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
                        let to_turn_count =
                            discovered_turns.map(|v| v.last().copied().unwrap_or(0));
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
                if panel.scope == requested {
                    panel.scope = scope.clone();
                }
                panel.branch_commits = commits_for_ui;
                panel.resolved_base_ref = resolved_base;
                panel.resolved_head_ref = resolved_head;
                match result {
                    Ok(files) => panel.install_files(files, scope_key, keep_selected),
                    Err(err) => {
                        panel.pending_reveal = None;
                        panel.state = DiffLoadState::Error(err);
                        panel.rebuild_rows();
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
                .a11y_group("panel.diff.scope-menu", "Diff scope")
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
                                .a11y_button(
                                    format!("panel.diff.scope-commit.{short_sha}"),
                                    format!("Commit {short_sha}"),
                                )
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
                        .a11y_button("panel.diff.scope-all", "All changes")
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
                            .a11y_button(
                                format!("panel.diff.scope-turn.{turn}"),
                                format!("Turn {turn}"),
                            )
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
                    .a11y_group("panel.diff.base-ref-menu", "Base branch")
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
                        .a11y_button("panel.diff.base-ref-auto", "Automatic base branch")
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
                            .a11y_button(
                                format!("panel.diff.base-ref.{ref_name}"),
                                ref_name.to_string(),
                            )
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
                                    .a11y_button(
                                        "panel.diff.mode-toggle",
                                        "Toggle split or unified diff",
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
                                        cx.listener(|this, _, _, cx| this.toggle_view_mode(cx)),
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
                                    .a11y_button("panel.diff.wrap", "Toggle line wrap")
                                    .size(px(TOOLBAR_BTN_SIZE_PX))
                                    .rounded(px(9999.0))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .cursor_pointer()
                                    .hover(move |s| s.bg(hover_bg))
                                    .on_mouse_down(
                                        MouseButton::Left,
                                        cx.listener(|this, _, _, cx| this.toggle_word_wrap(cx)),
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
                                    .a11y_button("panel.diff.tree-toggle", "Toggle file tree")
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
            .a11y_group("panel.diff.files", "Changed files")
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
                .a11y_button(format!("panel.diff.file.{idx}"), file.display_path.clone())
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
                    cx.listener(move |this, _, _, cx| this.select_file(idx, cx)),
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

    /// One file's header: type icon, path, counts and the viewed checkbox. `sticky` draws the copy
    /// pinned over the list; the in-list copy scrolls away with its file.
    fn render_file_header(
        &self,
        index: usize,
        file: &DiffFile,
        sticky: bool,
        cx: &Context<'_, Self>,
    ) -> AnyElement {
        let pal = self.palette;
        let header_kind = if sticky {
            "sticky-header"
        } else {
            "file-header"
        };
        let viewed_kind = if sticky { "sticky-viewed" } else { "viewed" };
        let header_icon = crate::file_icons::file_icon(&file.display_path);
        let header_icon_color = header_icon
            .color
            .map(|c| to_hsla(c.for_appearance(self.tokens.appearance)))
            .unwrap_or(pal.muted);

        // A rounded, subdued box; checked it fills with the primary colour and shows a check.
        let viewed = self.is_viewed(index, file);
        let primary = to_hsla(self.tokens.primary);
        let viewed_checkbox = div()
            .id(SharedString::from(format!("diff-{viewed_kind}-{index}")))
            .a11y_button(
                format!("panel.diff.{viewed_kind}.{index}"),
                format!(
                    "Mark {} as {}",
                    file.display_path,
                    if viewed { "unviewed" } else { "viewed" }
                ),
            )
            .flex()
            .items_center()
            .justify_center()
            .flex_none()
            .size(px(16.0))
            .rounded(px(5.0))
            .border_1()
            .border_color(if viewed {
                primary
            } else {
                to_hsla(self.tokens.muted_foreground.with_alpha(0.45))
            })
            .bg(if viewed {
                primary
            } else {
                to_hsla(self.tokens.shell_highlight)
            })
            .cursor_pointer()
            .on_click(cx.listener(move |this, _, _, cx| {
                this.toggle_viewed(index);
                cx.notify();
            }))
            .when(viewed, |el| {
                el.child(superhero_icon(
                    "superhero/check.svg",
                    12.0,
                    to_hsla(self.tokens.primary_foreground),
                ))
            });

        h_flex()
            .id(SharedString::from(format!("diff-{header_kind}-{index}")))
            .a11y_group(
                format!("panel.diff.{header_kind}.{index}"),
                file.display_path.clone(),
            )
            .w_full()
            .h(px(FILE_HEADER_HEIGHT_PX))
            .flex_shrink_0()
            .px(px(12.0))
            .gap(px(8.0))
            .items_center()
            .justify_between()
            .border_b_1()
            .border_color(pal.divider)
            .when(sticky, |el| el.bg(pal.card_bg))
            .child(
                h_flex()
                    .flex_1()
                    .min_w_0()
                    .items_center()
                    .gap(px(6.0))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, _, _, cx| {
                            this.selected_index = index;
                            cx.notify();
                        }),
                    )
                    .child(superhero_icon(header_icon.asset, 14.0, header_icon_color))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(UI_TEXT_PX))
                            .line_height(px(UI_LINE_HEIGHT_PX))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(pal.ui_fg)
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
                                .text_color(pal.added)
                                .child(format!("+{}", file.additions)),
                        )
                    })
                    .when(file.deletions > 0, |el| {
                        el.child(
                            div()
                                .text_color(pal.removed)
                                .child(format!("-{}", file.deletions)),
                        )
                    }),
            )
            .child(viewed_checkbox)
            .into_any_element()
    }

    /// The header pinned over the top of the list, or `None` while the file's own header is at the
    /// top. The next file's header pushes it up as they meet, so one 1px line separates them.
    fn render_sticky_header(&self, cx: &Context<'_, Self>) -> Option<AnyElement> {
        let DiffLoadState::Loaded(files) = &self.state else {
            return None;
        };
        let file = self.top_file()?;
        let header_row = *self.file_starts.get(file)?;
        let top = self.list_state.logical_scroll_top();
        if top.item_ix == header_row && top.offset_in_item <= px(0.0) {
            return None;
        }
        let viewport_top = self.list_state.viewport_bounds().top();
        let offset = self
            .file_starts
            .get(file + 1)
            .and_then(|&next| self.list_state.bounds_for_item(next))
            .map_or(0.0, |bounds| {
                sticky_push(f32::from(bounds.top() - viewport_top))
            });
        let header = self.render_file_header(file, files.get(file)?, true, cx);
        Some(
            div()
                .absolute()
                .top(px(offset))
                .left_0()
                .right_0()
                .child(header)
                .into_any_element(),
        )
    }

    /// One virtualized row of the continuous diff.
    fn render_row(&mut self, ix: usize, cx: &mut Context<'_, Self>) -> AnyElement {
        let Some(row) = self.rows.get(ix).copied() else {
            return div().into_any_element();
        };
        let DiffLoadState::Loaded(files) = &self.state else {
            return div().into_any_element();
        };
        let files = Rc::clone(files);
        let pal = self.palette;
        let mono = SharedString::from(cx.theme().mono_font_family.to_string());

        match row {
            DiffRow::Header { file } => files.get(file).map_or_else(
                || div().into_any_element(),
                |diff_file| self.render_file_header(file, diff_file, false, cx),
            ),
            DiffRow::Notice { kind, .. } => div()
                .w_full()
                .px(px(16.0))
                .py(px(12.0))
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(pal.muted)
                .child(match kind {
                    NoticeKind::Binary => "Binary file changed.",
                    NoticeKind::NoLines => "No textual diff lines.",
                })
                .into_any_element(),
            DiffRow::Hunk { file, hunk } => {
                let header = files
                    .get(file)
                    .and_then(|f| f.hunks.get(hunk))
                    .map(|h| h.header.clone())
                    .unwrap_or_default();
                div()
                    .w_full()
                    .px(px(12.0))
                    .py(px(3.0))
                    .bg(pal.separator_bg)
                    .when(hunk > 0, |el| el.border_t_1().border_color(pal.divider))
                    .border_b_1()
                    .border_color(pal.divider)
                    .font_family(mono)
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(pal.muted)
                    .child(header)
                    .into_any_element()
            }
            DiffRow::Line { file, hunk, line } => {
                let Some(diff_file) = files.get(file) else {
                    return div().into_any_element();
                };
                let Some(diff_line) = diff_file.hunks.get(hunk).and_then(|h| h.lines.get(line))
                else {
                    return div().into_any_element();
                };
                let highlight = self.highlight_for(file, diff_file);
                let spans = highlight
                    .hunk_base
                    .get(hunk)
                    .and_then(|base| highlight.lines.get(base + line))
                    .map(Vec::as_slice);
                unified_line_row(diff_line, spans, &pal, &mono, self.word_wrap)
            }
            DiffRow::Split {
                file,
                hunk,
                left,
                right,
            } => {
                let Some(diff_file) = files.get(file) else {
                    return div().into_any_element();
                };
                let Some(diff_hunk) = diff_file.hunks.get(hunk) else {
                    return div().into_any_element();
                };
                let highlight = self.highlight_for(file, diff_file);
                let base = highlight.hunk_base.get(hunk).copied().unwrap_or(0);
                let side = |idx: Option<usize>| {
                    let line = idx.and_then(|i| diff_hunk.lines.get(i));
                    let spans = idx
                        .and_then(|i| highlight.lines.get(base + i))
                        .map(Vec::as_slice);
                    split_side(line, spans, &pal, &mono, self.word_wrap)
                };
                h_flex()
                    .w_full()
                    .items_stretch()
                    .child(side(left))
                    .child(div().w(px(1.0)).flex_shrink_0().bg(pal.divider))
                    .child(side(right))
                    .into_any_element()
            }
            DiffRow::FileEnd { file } => {
                let last = file + 1 >= files.len();
                div()
                    .w_full()
                    .h(px(FILE_END_GAP_PX))
                    .when(!last, |el| el.border_b_1().border_color(pal.divider))
                    .into_any_element()
            }
            DiffRow::Tail => div().w_full().h(px(LIST_TAIL_PX)).into_any_element(),
        }
    }

    /// The continuous multi-file diff: a virtualized list with the sticky header over it.
    fn render_diff_view(&self, cx: &mut Context<'_, Self>) -> AnyElement {
        let list_state = self.list_state.clone();
        let virtual_list = list(
            list_state.clone(),
            cx.processor(|this, ix: usize, _window, cx| this.render_row(ix, cx)),
        )
        .size_full()
        .min_h_0();
        let sticky = self.render_sticky_header(cx);

        v_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .child(
                div()
                    .id("diff-body-scroll")
                    .a11y_group("panel.diff.body", "Diff content")
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .overflow_hidden()
                    .child(virtual_list)
                    .when_some(sticky, |el, header| el.child(header))
                    .child(
                        div()
                            .absolute()
                            .inset_0()
                            .child(div().size_full().vertical_scrollbar(&list_state)),
                    ),
            )
            .into_any_element()
    }
}

impl Render for DiffPanel {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        self.ensure_scroll_handler(cx);
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
                let mut split = h_flex().flex_1().min_h_0().w_full();
                if self.file_tree_open {
                    let split_handle = div()
                        .id("diff-split-handle")
                        .a11y_group("panel.diff.split-handle", "Resize diff panes")
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
                split.child(self.render_diff_view(cx)).into_any_element()
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

/// One unified diff line: old and new line numbers, change sign and syntax-colored text.
fn unified_line_row(
    line: &DiffLine,
    spans: Option<&[HighlightSpan]>,
    pal: &DiffPalette,
    mono: &SharedString,
    word_wrap: bool,
) -> AnyElement {
    let (row_bg, gutter_bg, sign, sign_color) = match line.kind {
        DiffLineKind::Added => (
            Some(pal.added_bg),
            Some(pal.added_gutter_bg),
            "+",
            pal.added,
        ),
        DiffLineKind::Removed => (
            Some(pal.removed_bg),
            Some(pal.removed_gutter_bg),
            "-",
            pal.removed,
        ),
        DiffLineKind::Context => (None, None, " ", pal.muted),
    };
    let old_no = line.old_line.map_or_else(String::new, |n| n.to_string());
    let new_no = line.new_line.map_or_else(String::new, |n| n.to_string());

    let gutter = h_flex()
        .flex_shrink_0()
        .items_start()
        .border_r_1()
        .border_color(pal.divider)
        .when_some(gutter_bg, |el, bg| el.bg(bg))
        .child(
            div()
                .w(px(36.0))
                .flex_shrink_0()
                .pr(px(6.0))
                .text_right()
                .text_color(pal.gutter_fg)
                .child(old_no),
        )
        .child(
            div()
                .w(px(36.0))
                .flex_shrink_0()
                .pr(px(8.0))
                .text_right()
                .text_color(pal.gutter_fg)
                .child(new_no),
        );

    let mut row = h_flex()
        .w_full()
        .font_family(mono.clone())
        .text_size(px(UI_TEXT_PX))
        .line_height(px(UI_LINE_HEIGHT_PX));
    if let Some(bg) = row_bg {
        row = row.bg(bg);
    }
    row.child(gutter)
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
                .when(!word_wrap, |el| el.overflow_hidden().whitespace_nowrap())
                .text_color(pal.code_fg)
                .child(styled_diff_line(&line.text, spans)),
        )
        .into_any_element()
}

/// One half of a split diff row. `None` draws the empty side opposite an added or removed line.
fn split_side(
    line: Option<&DiffLine>,
    spans: Option<&[HighlightSpan]>,
    pal: &DiffPalette,
    mono: &SharedString,
    word_wrap: bool,
) -> AnyElement {
    let Some(line) = line else {
        return h_flex()
            .flex_1()
            .min_w_0()
            .font_family(mono.clone())
            .text_size(px(UI_TEXT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .child(
                div()
                    .w(px(38.0))
                    .flex_shrink_0()
                    .border_r_1()
                    .border_color(pal.divider)
                    .child(" "),
            )
            .child(div().flex_1().min_w_0().child(" "))
            .into_any_element();
    };
    let (row_bg, gutter_bg, sign, sign_color, line_no) = match line.kind {
        DiffLineKind::Added => (
            Some(pal.added_bg),
            Some(pal.added_gutter_bg),
            "+",
            pal.added,
            line.new_line.map_or_else(String::new, |n| n.to_string()),
        ),
        DiffLineKind::Removed => (
            Some(pal.removed_bg),
            Some(pal.removed_gutter_bg),
            "-",
            pal.removed,
            line.old_line.map_or_else(String::new, |n| n.to_string()),
        ),
        DiffLineKind::Context => (
            None,
            None,
            " ",
            pal.muted,
            line.old_line
                .or(line.new_line)
                .map_or_else(String::new, |n| n.to_string()),
        ),
    };
    let mut side = h_flex()
        .flex_1()
        .min_w_0()
        .font_family(mono.clone())
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
            .border_color(pal.divider)
            .when_some(gutter_bg, |el, bg| el.bg(bg))
            .text_right()
            .text_color(pal.gutter_fg)
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
            .when(!word_wrap, |el| el.overflow_hidden().whitespace_nowrap())
            .text_color(pal.code_fg)
            .child(styled_diff_line(&line.text, spans)),
    )
    .into_any_element()
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

    const THREE_FILE_PATCH: &str = "\
diff --git a/a.rs b/a.rs
--- a/a.rs
+++ b/a.rs
@@ -1,2 +1,2 @@
 keep
-old
+new
diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
diff --git a/c.rs b/c.rs
--- a/c.rs
+++ b/c.rs
@@ -1,1 +1,2 @@
 keep
+added
@@ -9,1 +10,1 @@
-x
+y
";

    #[test]
    fn build_rows_flattens_files_with_headers_ends_and_tail() {
        let files = parse_unified_diff(THREE_FILE_PATCH);
        assert_eq!(files.len(), 3);
        let (rows, starts) = build_rows(&files, DiffViewMode::Unified);
        // a.rs: header, hunk, 3 lines, end. img.png: header, notice, end.
        // c.rs: header, hunk, 2 lines, hunk, 2 lines, end. Then the tail.
        assert_eq!(starts, vec![0, 6, 9]);
        assert_eq!(rows.len(), 9 + 1 + 1 + 2 + 1 + 2 + 1 + 1);
        assert_eq!(rows[0], DiffRow::Header { file: 0 });
        assert_eq!(
            rows[7],
            DiffRow::Notice {
                file: 1,
                kind: NoticeKind::Binary
            }
        );
        assert_eq!(rows[5], DiffRow::FileEnd { file: 0 });
        assert_eq!(rows.last(), Some(&DiffRow::Tail));
    }

    #[test]
    fn build_rows_pairs_changes_in_split_mode() {
        let files = parse_unified_diff(THREE_FILE_PATCH);
        let (rows, _) = build_rows(&files, DiffViewMode::Split);
        // a.rs: context row, then the removed and added lines side by side.
        assert_eq!(
            rows[2],
            DiffRow::Split {
                file: 0,
                hunk: 0,
                left: Some(0),
                right: Some(0)
            }
        );
        assert_eq!(
            rows[3],
            DiffRow::Split {
                file: 0,
                hunk: 0,
                left: Some(1),
                right: Some(2)
            }
        );
        assert_eq!(rows[4], DiffRow::FileEnd { file: 0 });
    }

    #[test]
    fn build_rows_of_no_files_is_empty() {
        let (rows, starts) = build_rows(&[], DiffViewMode::Unified);
        assert!(rows.is_empty());
        assert!(starts.is_empty());
    }

    #[test]
    fn file_for_row_finds_the_section_holding_a_row() {
        let starts = [0, 6, 9];
        assert_eq!(file_for_row(&starts, 0), 0);
        assert_eq!(file_for_row(&starts, 5), 0);
        assert_eq!(file_for_row(&starts, 6), 1);
        assert_eq!(file_for_row(&starts, 8), 1);
        assert_eq!(file_for_row(&starts, 9), 2);
        // Rows past the last header, such as the tail, belong to the last file.
        assert_eq!(file_for_row(&starts, 99), 2);
        assert_eq!(file_for_row(&[], 4), 0);
    }

    #[test]
    fn sticky_header_is_pushed_only_while_the_next_header_is_within_one_header() {
        assert!((sticky_push(200.0) - 0.0).abs() < f32::EPSILON);
        assert!((sticky_push(FILE_HEADER_HEIGHT_PX) - 0.0).abs() < f32::EPSILON);
        assert!((sticky_push(20.0) - -12.0).abs() < f32::EPSILON);
        assert!((sticky_push(0.0) - -FILE_HEADER_HEIGHT_PX).abs() < f32::EPSILON);
    }

    #[test]
    fn turn_scope_diffs_a_turn_against_the_one_before_it() {
        assert_eq!(turn_scope(1, &[]), DiffScope::Turn { from: 0, to: 1 });
        assert_eq!(turn_scope(4, &[]), DiffScope::Turn { from: 3, to: 4 });
        // Known checkpoints decide the base, as the scope menu lists them.
        assert_eq!(
            turn_scope(5, &[1, 3, 5]),
            DiffScope::Turn { from: 3, to: 5 }
        );
        assert_eq!(turn_scope(1, &[1, 2]), DiffScope::Turn { from: 0, to: 1 });
    }

    #[test]
    fn find_file_for_path_matches_workspace_relative_and_suffix_paths() {
        let files = parse_unified_diff(THREE_FILE_PATCH);
        assert_eq!(find_file_for_path(&files, "a.rs"), Some(0));
        assert_eq!(find_file_for_path(&files, "./c.rs"), Some(2));
        assert_eq!(find_file_for_path(&files, "/work/tree/c.rs"), Some(2));
        assert_eq!(find_file_for_path(&files, "missing.rs"), None);
        assert_eq!(find_file_for_path(&files, ""), None);
    }

    fn test_panel(cx: &mut gpui_kit::TestAppContext) -> gpui_kit::Entity<DiffPanel> {
        let theme = conn_theme::theme_by_id("dark-ocean").expect("dark-ocean is built in");
        let tokens = Tokens::derive(&theme);
        cx.new(|_| DiffPanel::new(tokens, None))
    }

    #[gpui_kit::test]
    fn turn_request_survives_the_thread_binding_of_a_new_panel(cx: &mut gpui_kit::TestAppContext) {
        let panel = test_panel(cx);
        // The timeline click arrives before the new panel knows its thread.
        panel.update(cx, |panel, cx| {
            panel.open_turn_diff(Some(1), Some("src/a.rs".to_owned()), cx);
        });
        panel.update(cx, |panel, cx| {
            panel.set_thread(Some("thread-1".to_owned()), cx)
        });
        assert_eq!(
            panel.read_with(cx, |panel, _| panel.focus_state()),
            ("Turn 1".to_owned(), Some("src/a.rs".to_owned()))
        );
    }

    #[gpui_kit::test]
    fn turn_request_retargets_a_panel_that_already_has_its_thread(
        cx: &mut gpui_kit::TestAppContext,
    ) {
        let panel = test_panel(cx);
        panel.update(cx, |panel, cx| {
            panel.set_thread(Some("thread-1".to_owned()), cx)
        });
        panel.update(cx, |panel, cx| {
            panel.open_turn_diff(Some(3), Some("b.rs".to_owned()), cx);
        });
        assert_eq!(
            panel.read_with(cx, |panel, _| panel.focus_state()),
            ("Turn 3".to_owned(), Some("b.rs".to_owned()))
        );
        panel.update(cx, |panel, cx| panel.open_turn_diff(None, None, cx));
        assert_eq!(
            panel.read_with(cx, |panel, _| panel.focus_state()),
            ("All turns".to_owned(), None)
        );
        // Another thread does not inherit the reveal or the turn.
        panel.update(cx, |panel, cx| {
            panel.open_turn_diff(Some(2), Some("c.rs".to_owned()), cx);
            panel.set_thread(Some("thread-2".to_owned()), cx);
        });
        assert_eq!(
            panel.read_with(cx, |panel, _| panel.focus_state()),
            ("All turns".to_owned(), None)
        );
    }

    #[gpui_kit::test]
    fn turn_card_diffs_only_its_own_turn_after_later_turns_complete(
        cx: &mut gpui_kit::TestAppContext,
    ) {
        let panel = test_panel(cx);
        // Diff was opened after turn 1, so the panel's cached checkpoints stop there.
        panel.update(cx, |panel, cx| {
            panel.set_thread(Some("thread-1".to_owned()), cx);
            panel.available_turns = vec![1];
        });
        // Turns 2 and 3 complete; then the reader opens turn 3's card.
        panel.update(cx, |panel, cx| panel.open_turn_diff(Some(3), None, cx));
        let scope = panel.read_with(cx, |panel, _| panel.scope.clone());
        assert_eq!(
            request_scope(&scope, &[1, 2, 3]),
            DiffScope::Turn { from: 2, to: 3 },
            "turn 3's card compares checkpoint 2 with checkpoint 3, not 1 with 3"
        );
        // Other scopes load as they are.
        assert_eq!(
            request_scope(&DiffScope::AllChanges, &[1, 2, 3]),
            DiffScope::AllChanges
        );
        assert_eq!(
            request_scope(&DiffScope::Turn { from: 1, to: 3 }, &[]),
            DiffScope::Turn { from: 1, to: 3 },
            "without fresh checkpoints the request keeps its range"
        );
    }

    #[test]
    fn an_exact_path_wins_over_a_suffix_match() {
        let files = parse_unified_diff(
            "\
diff --git a/apps/web/package.json b/apps/web/package.json
--- a/apps/web/package.json
+++ b/apps/web/package.json
@@ -1,1 +1,1 @@
-a
+b
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -1,1 +1,1 @@
-c
+d
",
        );
        assert_eq!(find_file_for_path(&files, "package.json"), Some(1));
        assert_eq!(find_file_for_path(&files, "./package.json"), Some(1));
        assert_eq!(find_file_for_path(&files, "web/package.json"), Some(0));
        assert_eq!(
            find_file_for_path(&files, "/repo/apps/web/package.json"),
            Some(0)
        );
    }

    #[gpui_kit::test]
    fn a_replaced_binary_loses_its_viewed_mark(cx: &mut gpui_kit::TestAppContext) {
        let binary = |hashes: &str| {
            parse_unified_diff(&format!(
                "diff --git a/img.png b/img.png\nindex {hashes} 100644\nBinary files a/img.png and b/img.png differ\n"
            ))
        };
        let panel = test_panel(cx);
        panel.update(cx, |panel, _| {
            panel.install_files(binary("1111111..2222222"), "turn".to_owned(), None);
            panel.toggle_viewed(0);
        });
        let viewed = |panel: &DiffPanel| {
            let DiffLoadState::Loaded(files) = &panel.state else {
                panic!("files are loaded");
            };
            panel.is_viewed(0, &files[0])
        };
        assert!(panel.read_with(cx, |panel, _| viewed(panel)));
        // The same scope refreshes with the same bytes: the mark stays.
        panel.update(cx, |panel, _| {
            panel.install_files(binary("1111111..2222222"), "turn".to_owned(), None);
        });
        assert!(panel.read_with(cx, |panel, _| viewed(panel)));
        // The agent replaces the image: the diff is again "Binary files differ", with new blobs.
        panel.update(cx, |panel, _| {
            panel.install_files(binary("1111111..3333333"), "turn".to_owned(), None);
        });
        assert!(
            !panel.read_with(cx, |panel, _| viewed(panel)),
            "a binary with new content is not viewed"
        );
    }

    #[test]
    fn viewed_scope_key_separates_scopes_and_base_branches() {
        assert_eq!(viewed_scope_key(&DiffScope::Branch, None), "branch:auto");
        assert_ne!(
            viewed_scope_key(&DiffScope::Branch, Some("main")),
            viewed_scope_key(&DiffScope::Branch, None)
        );
        assert_ne!(
            viewed_scope_key(&DiffScope::WorkingTree, None),
            viewed_scope_key(&DiffScope::AllChanges, None)
        );
        assert_ne!(
            viewed_scope_key(&DiffScope::Turn { from: 0, to: 1 }, None),
            viewed_scope_key(&DiffScope::Turn { from: 1, to: 2 }, None)
        );
    }

    #[test]
    fn file_fingerprint_changes_only_with_the_diff_content() {
        let files = parse_unified_diff(THREE_FILE_PATCH);
        let again = parse_unified_diff(THREE_FILE_PATCH);
        assert_eq!(file_fingerprint(&files[0]), file_fingerprint(&again[0]));
        assert_ne!(file_fingerprint(&files[0]), file_fingerprint(&files[2]));
        let edited = parse_unified_diff(&THREE_FILE_PATCH.replace("+new", "+newer"));
        assert_ne!(file_fingerprint(&files[0]), file_fingerprint(&edited[0]));
        assert_eq!(file_fingerprint(&files[2]), file_fingerprint(&edited[2]));
    }

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
