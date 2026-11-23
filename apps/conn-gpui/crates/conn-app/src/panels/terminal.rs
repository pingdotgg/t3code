//! Real local PTY terminal surface powered by `alacritty_terminal` 0.26 and a custom GPUI Element.
//!
//! Starts the user's login shell lazily on first display in `workspace_root` (fallback `$HOME`),
//! repaints only on PTY output (no continuous animation/blink loop), and kills the PTY child
//! process when dropped.

use crate::a11y::ConnA11yExt as _;
use std::borrow::Cow;
use std::fmt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use alacritty_terminal::event::{Event as TermEvent, EventListener, WindowSize};
use alacritty_terminal::event_loop::{EventLoop, EventLoopSender, Msg};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line as GridLine, Point as GridPoint, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::tty;
use alacritty_terminal::vte::ansi::{CursorShape, CursorStyle as AnsiCursorStyle};
use conn_theme::Tokens;
use gpui_kit::component::{ActiveTheme as _, h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    App, BorderStyle, Bounds, ClipboardItem, ContentMask, Context, CursorStyle, DispatchPhase,
    Element, ElementId, ElementInputHandler, Entity, EntityInputHandler, FocusHandle, Focusable,
    Font, GlobalElementId, Hitbox, HitboxBehavior, Hsla, InspectorElementId, InteractiveElement,
    IntoElement, KeyDownEvent, LayoutId, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent,
    ParentElement, Pixels, Point, Render, ScrollDelta, ScrollEvent, ShapedLine, StrikethroughStyle,
    Style, Styled, Task, TextAlign, TextRun, UTF16Selection, UnderlineStyle, Window, div, fill,
    font, outline, point, px, relative, size,
};
use tokio::sync::mpsc;

use super::color::{Rgb8, rgb8_to_hsla, to_hsla};
use super::header::superhero_icon;
use super::terminal_palette::{
    KeyInput, TerminalKeyAction, TerminalPalette, dim_rgb8, encode_terminal_key,
};

const TERMINAL_FONT_SIZE_PX: f32 = 13.0;
const TERMINAL_PAD_START_PX: f32 = 16.0;
const TERMINAL_PAD_TOP_PX: f32 = 16.0;
const TERMINAL_PAD_END_PX: f32 = 12.0;
const TERMINAL_PAD_BOTTOM_PX: f32 = 12.0;
const TOOLBAR_HEIGHT_PX: f32 = 32.0;
const TOOLBAR_INNER_PAD_PX: f32 = 3.0;
const TOOLBAR_BTN_SIZE_PX: f32 = 24.0;

#[derive(Clone, Copy, Debug, PartialEq)]
struct GridSize {
    cols: u16,
    rows: u16,
    cell_width: f32,
    cell_height: f32,
}

impl Default for GridSize {
    fn default() -> Self {
        Self {
            cols: 80,
            rows: 24,
            cell_width: 8.0,
            cell_height: 18.0,
        }
    }
}

impl GridSize {
    fn window_size(self) -> WindowSize {
        WindowSize {
            num_lines: self.rows,
            num_cols: self.cols,
            cell_width: self.cell_width.round().max(1.0) as u16,
            cell_height: self.cell_height.round().max(1.0) as u16,
        }
    }
}

impl Dimensions for GridSize {
    fn total_lines(&self) -> usize {
        usize::from(self.rows)
    }

    fn screen_lines(&self) -> usize {
        usize::from(self.rows)
    }

    fn columns(&self) -> usize {
        usize::from(self.cols)
    }
}

enum TermNote {
    Wakeup,
    Exited,
    Copy(String),
}

struct SharedState {
    dirty: AtomicBool,
    sender: OnceLock<EventLoopSender>,
    notes: mpsc::UnboundedSender<TermNote>,
}

#[derive(Clone)]
struct Listener(Arc<SharedState>);

impl EventListener for Listener {
    fn send_event(&self, event: TermEvent) {
        match event {
            TermEvent::Wakeup => {
                // Coalesce bursts of PTY output into a single UI repaint notification.
                if !self.0.dirty.swap(true, Ordering::AcqRel) {
                    let _ = self.0.notes.send(TermNote::Wakeup);
                }
            }
            TermEvent::Exit | TermEvent::ChildExit(_) => {
                let _ = self.0.notes.send(TermNote::Exited);
            }
            TermEvent::ClipboardStore(_, text) => {
                let _ = self.0.notes.send(TermNote::Copy(text));
            }
            _ => {}
        }
    }
}

/// Live PTY session owned by [`TerminalPanel`]. Kills the child process on drop.
struct TerminalSession {
    term: Arc<FairMutex<Term<Listener>>>,
    shared: Arc<SharedState>,
    #[cfg(unix)]
    child_pid: Option<i32>,
    size: GridSize,
    exited: bool,
    failed: Option<String>,
    _events_task: Task<()>,
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        if let Some(sender) = self.shared.sender.get() {
            let _ = sender.send(Msg::Shutdown);
        }
        #[cfg(unix)]
        if let Some(pid) = self.child_pid.take()
            && pid > 0
            && !self.exited
        {
            // SAFETY: `pid` is the child shell's own process ID returned by `tty::new` (which
            // starts the shell in a new session via setsid, making `-pid` its process group).
            // Sending SIGHUP asks the login shell and its foreground jobs to exit cleanly.
            unsafe {
                libc::kill(-pid, libc::SIGHUP);
                libc::kill(pid, libc::SIGTERM);
            }
        }
    }
}

/// Last painted terminal viewport origin and cell geometry, for pointer-to-cell hit testing.
#[derive(Clone, Copy, Debug, PartialEq)]
struct DrawnAt {
    origin: Point<Pixels>,
    cell_width: Pixels,
    cell_height: Pixels,
}

/// Interactive terminal panel backed by `alacritty_terminal`.
pub(crate) struct TerminalPanel {
    tokens: Tokens,
    palette: TerminalPalette,
    workspace_root: Option<String>,
    session: Option<TerminalSession>,
    focus: FocusHandle,
    marked: String,
    scroll_remainder: f32,
    drawn_at: Option<DrawnAt>,
    selecting: bool,
}

impl fmt::Debug for TerminalPanel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TerminalPanel")
            .field("workspace_root", &self.workspace_root)
            .field("started", &self.session.is_some())
            .finish_non_exhaustive()
    }
}

impl TerminalPanel {
    pub(crate) fn new(tokens: Tokens, cx: &mut Context<'_, Self>) -> Self {
        let palette = TerminalPalette::from_tokens(&tokens);
        Self {
            tokens,
            palette,
            workspace_root: None,
            session: None,
            focus: cx.focus_handle(),
            marked: String::new(),
            scroll_remainder: 0.0,
            drawn_at: None,
            selecting: false,
        }
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.palette = TerminalPalette::from_tokens(&tokens);
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
        cx.notify();
    }

    /// Lazily spawns the user's login shell on first display of the Terminal tab.
    pub(crate) fn ensure_started(&mut self, cx: &mut Context<'_, Self>) {
        if self.session.is_some() {
            return;
        }
        let cwd = resolve_cwd(self.workspace_root.as_deref());
        self.session = Some(self.start_session(cwd, cx));
        cx.notify();
    }

    /// Moves keyboard focus to the terminal.
    pub(crate) fn focus(&self, window: &mut Window, cx: &mut Context<'_, Self>) {
        window.focus(&self.focus, cx);
    }

    /// Restarts the login shell in the current workspace root.
    fn restart_session(&mut self, cx: &mut Context<'_, Self>) {
        let cwd = resolve_cwd(self.workspace_root.as_deref());
        self.session = Some(self.start_session(cwd, cx));
        cx.notify();
    }

    /// Clears the terminal screen and scrollback (equivalent to Ctrl+L / clear).
    fn clear_terminal(&mut self, cx: &mut Context<'_, Self>) {
        if let Some(session) = &self.session {
            let mut term = session.term.lock();
            term.grid_mut().clear_history();
            term.scroll_display(Scroll::Bottom);
            drop(term);
            self.write_bytes(b"\x0c".to_vec());
            cx.notify();
        }
    }

    fn start_session(&self, cwd: PathBuf, cx: &mut Context<'_, Self>) -> TerminalSession {
        let size = GridSize::default();
        let (notes_tx, mut notes_rx) = mpsc::unbounded_channel();
        let shared = Arc::new(SharedState {
            dirty: AtomicBool::new(false),
            sender: OnceLock::new(),
            notes: notes_tx,
        });
        let config = Config {
            default_cursor_style: AnsiCursorStyle {
                shape: CursorShape::Block,
                blinking: false,
            },
            ..Config::default()
        };
        let term = Arc::new(FairMutex::new(Term::new(
            config,
            &size,
            Listener(shared.clone()),
        )));

        let events_task = cx.spawn(async move |this, cx| {
            while let Some(note) = notes_rx.recv().await {
                let alive = this.update(cx, |panel, cx| panel.handle_note(note, cx));
                if alive.is_err() {
                    break;
                }
            }
        });

        let mut session = TerminalSession {
            term,
            shared,
            #[cfg(unix)]
            child_pid: None,
            size,
            exited: false,
            failed: None,
            _events_task: events_task,
        };

        if let Err(err) = spawn_pty(&mut session, cwd) {
            session.exited = true;
            session.failed = Some(err.to_string());
        }

        session
    }

    fn handle_note(&mut self, note: TermNote, cx: &mut Context<'_, Self>) {
        match note {
            TermNote::Wakeup => {
                if let Some(session) = &self.session {
                    session.shared.dirty.store(false, Ordering::Release);
                }
            }
            TermNote::Exited => {
                if let Some(session) = &mut self.session {
                    session.exited = true;
                }
            }
            TermNote::Copy(text) => {
                cx.write_to_clipboard(ClipboardItem::new_string(text));
            }
        }
        cx.notify();
    }

    fn write_bytes(&self, bytes: Vec<u8>) {
        if bytes.is_empty() {
            return;
        }
        if let Some(session) = &self.session
            && !session.exited
            && let Some(sender) = session.shared.sender.get()
        {
            let _ = sender.send(Msg::Input(Cow::Owned(bytes)));
        }
    }

    fn resize(&mut self, next: GridSize) {
        let Some(session) = &mut self.session else {
            return;
        };
        if session.size == next {
            return;
        }
        session.size = next;
        session.term.lock().resize(next);
        if !session.exited
            && let Some(sender) = session.shared.sender.get()
        {
            let _ = sender.send(Msg::Resize(next.window_size()));
        }
    }

    fn key_down(&mut self, event: &KeyDownEvent, _window: &mut Window, cx: &mut Context<'_, Self>) {
        let k = &event.keystroke;
        let m = k.modifiers;

        let command = if cfg!(target_os = "macos") {
            m.platform
        } else {
            m.control && m.shift
        };
        if command {
            match k.key.as_str() {
                "c" => {
                    if let Some(session) = &self.session
                        && let Some(text) = session.term.lock().selection_to_string()
                        && !text.is_empty()
                    {
                        cx.write_to_clipboard(ClipboardItem::new_string(text));
                    }
                    cx.stop_propagation();
                }
                "v" => {
                    if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
                        self.send_text(&text, cx);
                    }
                    cx.stop_propagation();
                }
                "a" => {
                    self.select_all(cx);
                    cx.stop_propagation();
                }
                _ => {}
            }
            return;
        }

        let Some(session) = &self.session else {
            return;
        };
        if session.exited {
            return;
        }
        let mode = *session.term.lock().mode();
        let input = KeyInput {
            shift: m.shift,
            control: m.control,
            alt: m.alt,
            platform: m.platform,
            app_cursor: mode.contains(TermMode::APP_CURSOR),
            alt_screen: mode.contains(TermMode::ALT_SCREEN),
        };
        match encode_terminal_key(&k.key, input) {
            TerminalKeyAction::Send(bytes) => {
                self.scroll_to_bottom();
                self.write_bytes(bytes);
                cx.stop_propagation();
            }
            TerminalKeyAction::ScrollPage(dir) => {
                let mut term = session.term.lock();
                term.scroll_display(if dir < 0 {
                    Scroll::PageUp
                } else {
                    Scroll::PageDown
                });
                drop(term);
                cx.notify();
                cx.stop_propagation();
            }
            TerminalKeyAction::Nothing => cx.stop_propagation(),
            TerminalKeyAction::Pass => {}
        }
    }

    fn send_text(&mut self, text: &str, cx: &mut Context<'_, Self>) {
        self.marked.clear();
        if text.is_empty() {
            cx.notify();
            return;
        }
        self.scroll_to_bottom();
        let normalized = text.replace("\r\n", "\r").replace('\n', "\r");
        self.write_bytes(normalized.into_bytes());
        cx.notify();
    }

    fn scroll_to_bottom(&self) {
        if let Some(session) = &self.session {
            let mut term = session.term.lock();
            if term.grid().display_offset() != 0 {
                term.scroll_display(Scroll::Bottom);
            }
        }
    }

    fn select_all(&mut self, cx: &mut Context<'_, Self>) {
        let Some(session) = &self.session else {
            return;
        };
        let mut term = session.term.lock();
        let top = term.grid().topmost_line();
        let bottom = term.grid().bottommost_line();
        let last = term.grid().last_column();
        let mut selection = Selection::new(
            SelectionType::Simple,
            GridPoint::new(top, Column(0)),
            Side::Left,
        );
        selection.update(GridPoint::new(bottom, last), Side::Right);
        term.selection = Some(selection);
        drop(term);
        cx.notify();
    }

    fn cell_at(&self, position: Point<Pixels>, clamp: bool) -> Option<(usize, usize, Side)> {
        let at = self.drawn_at?;
        let size = self.session.as_ref()?.size;
        map_point_to_cell(position, at, size, clamp)
    }

    fn grid_point(&self, col: usize, row: usize) -> Option<GridPoint> {
        let session = self.session.as_ref()?;
        let offset = session.term.lock().grid().display_offset() as i32;
        Some(GridPoint::new(GridLine(row as i32 - offset), Column(col)))
    }

    fn mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        window.focus(&self.focus, cx);
        if event.button != MouseButton::Left {
            return;
        }
        let Some((col, row, side)) = self.cell_at(event.position, false) else {
            return;
        };
        let Some(grid_pt) = self.grid_point(col, row) else {
            return;
        };
        if let Some(session) = &self.session {
            let mut term = session.term.lock();
            match (
                event.click_count,
                event.modifiers.shift,
                term.selection.as_mut(),
            ) {
                (1, true, Some(selection)) => selection.update(grid_pt, side),
                (clicks, _, _) => {
                    let kind = match clicks {
                        2 => SelectionType::Semantic,
                        3.. => SelectionType::Lines,
                        _ => SelectionType::Simple,
                    };
                    term.selection = Some(Selection::new(kind, grid_pt, side));
                }
            }
        }
        self.selecting = true;
        cx.notify();
    }

    fn mouse_moved(&mut self, event: &MouseMoveEvent, cx: &mut Context<'_, Self>) {
        if !self.selecting {
            return;
        }
        if event.pressed_button != Some(MouseButton::Left) {
            self.selecting = false;
            return;
        }
        let Some((col, row, side)) = self.cell_at(event.position, true) else {
            return;
        };
        let Some(grid_pt) = self.grid_point(col, row) else {
            return;
        };
        if let Some(session) = &self.session
            && let Some(selection) = session.term.lock().selection.as_mut()
        {
            selection.update(grid_pt, side);
        }
        cx.notify();
    }

    fn mouse_up(&mut self, event: &MouseUpEvent, cx: &mut Context<'_, Self>) {
        if event.button != MouseButton::Left || !self.selecting {
            return;
        }
        self.selecting = false;
        cx.notify();
    }

    fn scrolled(&mut self, event: &ScrollEvent, cx: &mut Context<'_, Self>) {
        let Some(session) = &self.session else {
            return;
        };
        let delta_lines = match event.delta {
            ScrollDelta::Lines(delta) => delta.y,
            ScrollDelta::Pixels(delta) => f32::from(delta.y) / session.size.cell_height.max(1.0),
        };
        self.scroll_remainder += delta_lines;
        let whole = self.scroll_remainder.trunc() as i32;
        if whole != 0 {
            self.scroll_remainder -= whole as f32;
            session.term.lock().scroll_display(Scroll::Delta(whole));
            cx.notify();
        }
        cx.stop_propagation();
    }
}

impl Focusable for TerminalPanel {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl EntityInputHandler for TerminalPanel {
    fn text_for_range(
        &mut self,
        range: std::ops::Range<usize>,
        adjusted: &mut Option<std::ops::Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<'_, Self>,
    ) -> Option<String> {
        let utf16: Vec<u16> = self.marked.encode_utf16().collect();
        let clamped = range.start.min(utf16.len())..range.end.min(utf16.len());
        *adjusted = Some(clamped.clone());
        Some(String::from_utf16_lossy(&utf16[clamped]))
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<'_, Self>,
    ) -> Option<UTF16Selection> {
        let end = self.marked.encode_utf16().count();
        Some(UTF16Selection {
            range: end..end,
            reversed: false,
        })
    }

    fn marked_text_range(
        &self,
        _window: &mut Window,
        _cx: &mut Context<'_, Self>,
    ) -> Option<std::ops::Range<usize>> {
        (!self.marked.is_empty()).then(|| 0..self.marked.encode_utf16().count())
    }

    fn unmark_text(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) {
        self.marked.clear();
        cx.notify();
    }

    fn replace_text_in_range(
        &mut self,
        _range: Option<std::ops::Range<usize>>,
        text: &str,
        _window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.send_text(text, cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        _range: Option<std::ops::Range<usize>>,
        new_text: &str,
        _new_selected: Option<std::ops::Range<usize>>,
        _window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.marked = new_text.to_owned();
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        _range: std::ops::Range<usize>,
        element_bounds: Bounds<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<'_, Self>,
    ) -> Option<Bounds<Pixels>> {
        Some(Bounds {
            origin: element_bounds.origin,
            size: size(px(8.0), px(18.0)),
        })
    }

    fn character_index_for_point(
        &mut self,
        _point: Point<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<'_, Self>,
    ) -> Option<usize> {
        None
    }

    fn accepts_text_input(&self, _window: &mut Window, _cx: &mut Context<'_, Self>) -> bool {
        self.session.as_ref().is_some_and(|s| !s.exited)
    }
}

impl Render for TerminalPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let muted = to_hsla(self.tokens.muted_foreground);
        let control_bg = to_hsla(self.tokens.shell_control);
        let control_border = to_hsla(self.tokens.shell_divider_header);
        let hover_bg = to_hsla(self.tokens.shell_highlight);
        let focused = self.focus.is_focused(window);
        let entity = cx.entity();

        let status_banner = self.session.as_ref().and_then(|s| {
            if !s.exited {
                return None;
            }
            Some(match &s.failed {
                Some(why) => format!("Shell failed to start: {why}"),
                None => "Shell process exited.".to_owned(),
            })
        });

        // Floating top-right ToolbarGroup matching `ThreadTerminalDrawer.tsx` (`absolute right-2 top-2`).
        let action_group = h_flex()
            .absolute()
            .top(px(8.0))
            .right(px(8.0))
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
                    .id("terminal-clear-btn")
                    .a11y_button("panel.terminal.clear", "Clear terminal")
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
                            cx.stop_propagation();
                            this.clear_terminal(cx);
                        }),
                    )
                    .child(superhero_icon("superhero/clean.svg", 14.0, muted)),
            )
            .child(
                div()
                    .id("terminal-restart-btn")
                    .a11y_button("panel.terminal.restart", "Restart terminal")
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
                            cx.stop_propagation();
                            this.restart_session(cx);
                        }),
                    )
                    .child(superhero_icon("superhero/refresh.svg", 14.0, muted)),
            );

        v_flex()
            .id("terminal-panel")
            .a11y_group("panel.terminal", "Terminal")
            .relative()
            .size_full()
            .track_focus(&self.focus)
            .key_context("Terminal")
            .on_key_down(cx.listener(Self::key_down))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _: &MouseDownEvent, window, cx| {
                    window.focus(&this.focus, cx);
                }),
            )
            .child(
                div()
                    .flex_1()
                    .size_full()
                    .pl(px(TERMINAL_PAD_START_PX))
                    .pt(px(TERMINAL_PAD_TOP_PX))
                    .pr(px(TERMINAL_PAD_END_PX))
                    .pb(px(TERMINAL_PAD_BOTTOM_PX))
                    .child(TerminalElement {
                        panel: entity,
                        focused,
                    }),
            )
            .child(action_group)
            .when_some(status_banner, |el, msg| {
                el.child(
                    div()
                        .px(px(16.0))
                        .py(px(8.0))
                        .border_t_1()
                        .border_color(to_hsla(self.tokens.shell_divider))
                        .text_size(px(13.0))
                        .line_height(px(20.0))
                        .text_color(muted)
                        .child(msg),
                )
            })
    }
}

fn resolve_cwd(workspace_root: Option<&str>) -> PathBuf {
    if let Some(root) = workspace_root
        && !root.is_empty()
    {
        let p = PathBuf::from(root);
        if p.is_dir() {
            return p;
        }
    }
    if let Ok(home) = std::env::var("HOME")
        && !home.is_empty()
    {
        return PathBuf::from(home);
    }
    PathBuf::from("/")
}

fn spawn_pty(session: &mut TerminalSession, cwd: PathBuf) -> std::io::Result<()> {
    let shell_path = std::env::var("SHELL")
        .ok()
        .filter(|s| s.starts_with('/'))
        .unwrap_or_else(|| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".to_owned()
            } else {
                "/bin/sh".to_owned()
            }
        });
    let mut env = std::collections::HashMap::new();
    env.insert("TERM".to_owned(), "xterm-256color".to_owned());
    env.insert("COLORTERM".to_owned(), "truecolor".to_owned());
    env.insert("TERM_PROGRAM".to_owned(), "Conn".to_owned());
    if std::env::var("LANG").map_or(true, |v| v.is_empty()) {
        env.insert("LANG".to_owned(), "en_US.UTF-8".to_owned());
    }

    let options = tty::Options {
        shell: Some(tty::Shell::new(shell_path, vec!["-l".to_owned()])),
        working_directory: Some(cwd),
        drain_on_exit: true,
        env,
        #[cfg(target_os = "windows")]
        escape_args: false,
    };

    let pty = tty::new(&options, session.size.window_size(), 0)?;
    #[cfg(unix)]
    {
        session.child_pid = Some(pty.child().id() as i32);
    }

    let event_loop = EventLoop::new(
        session.term.clone(),
        Listener(session.shared.clone()),
        pty,
        true,
        false,
    )?;
    let _ = session.shared.sender.set(event_loop.channel());
    let _reader = event_loop.spawn();
    Ok(())
}

// ---------------------------------------------------------------- custom GPUI element

struct TerminalElement {
    panel: Entity<TerminalPanel>,
    focused: bool,
}

impl IntoElement for TerminalElement {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

enum CursorPaint {
    Block,
    Outline(Bounds<Pixels>, Hsla),
    Bar(Bounds<Pixels>, Hsla),
}

struct PrepaintedTerminal {
    backgrounds: Vec<(Bounds<Pixels>, Hsla)>,
    lines: Vec<(Point<Pixels>, ShapedLine)>,
    cursor: Option<CursorPaint>,
    hitbox: Hitbox,
    cell_height: Pixels,
}

struct CellRun {
    column: usize,
    cells: usize,
    text: String,
    color: Rgb8,
    bold: bool,
    italic: bool,
    underline: bool,
    strike: bool,
    wide: bool,
}

impl CellRun {
    fn matches(
        &self,
        color: Rgb8,
        bold: bool,
        italic: bool,
        underline: bool,
        strike: bool,
    ) -> bool {
        !self.wide
            && self.color == color
            && self.bold == bold
            && self.italic == italic
            && self.underline == underline
            && self.strike == strike
    }
}

struct FontMetrics {
    font: Font,
    size: Pixels,
    cell_width: f32,
    cell_height: f32,
}

fn measure_font(window: &Window, cx: &App) -> FontMetrics {
    let mono_family = cx.theme().mono_font_family.clone();
    let f = font(mono_family);
    let size = px(TERMINAL_FONT_SIZE_PX);
    let text = window.text_system();
    let id = text.resolve_font(&f);
    let advance = text
        .advance(id, size, 'W')
        .map(|s| f32::from(s.width))
        .unwrap_or(TERMINAL_FONT_SIZE_PX * 0.6);
    let raw_height =
        (f32::from(text.ascent(id, size)) + f32::from(text.descent(id, size)).abs()).ceil();
    let scale = window.scale_factor();
    FontMetrics {
        font: f,
        size,
        cell_width: ((advance * scale).round() / scale).max(1.0),
        cell_height: ((raw_height * scale).ceil() / scale).max(1.0),
    }
}

fn push_bg_run(
    row: usize,
    col: usize,
    cells: usize,
    color: Rgb8,
    out: &mut Vec<(usize, usize, usize, Rgb8)>,
) {
    if let Some(last) = out.last_mut()
        && last.0 == row
        && last.1 + last.2 == col
        && last.3 == color
    {
        last.2 += cells;
        return;
    }
    out.push((row, col, cells, color));
}

impl Element for TerminalElement {
    type RequestLayoutState = ();
    type PrepaintState = PrepaintedTerminal;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.0).into();
        style.size.height = relative(1.0).into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> PrepaintedTerminal {
        let m = measure_font(window, cx);
        let (cw, ch) = (m.cell_width, m.cell_height);
        let cols = ((f32::from(bounds.size.width) / cw).floor() as u16).max(2);
        let rows = ((f32::from(bounds.size.height) / ch).floor() as u16).max(1);
        let grid = GridSize {
            cols,
            rows,
            cell_width: cw,
            cell_height: ch,
        };
        self.panel.update(cx, |p, _| {
            p.resize(grid);
            p.drawn_at = Some(DrawnAt {
                origin: bounds.origin,
                cell_width: px(cw),
                cell_height: px(ch),
            });
        });

        let hitbox = window.insert_hitbox(bounds, HitboxBehavior::Normal);
        let cell_rect = |col: usize, row: usize, cells: usize| Bounds {
            origin: point(
                bounds.origin.x + px(cw * col as f32),
                bounds.origin.y + px(ch * row as f32),
            ),
            size: size(px(cw * cells as f32), px(ch)),
        };

        let panel = self.panel.read(cx);
        let palette = panel.palette.clone();
        let Some(session) = &panel.session else {
            return PrepaintedTerminal {
                backgrounds: Vec::new(),
                lines: Vec::new(),
                cursor: None,
                hitbox,
                cell_height: px(ch),
            };
        };

        let default_bg = palette.background;
        let term = session.term.lock();
        let content = term.renderable_content();
        let offset = content.display_offset as i32;
        let selection = content.selection;
        let cursor = content.cursor;
        let cursor_row = cursor.point.line.0 + offset;
        let cursor_visible =
            cursor.shape != CursorShape::Hidden && (0..i32::from(rows)).contains(&cursor_row);
        let solid_cursor = cursor_visible && self.focused && cursor.shape == CursorShape::Block;
        let overrides = content.colors;

        let mut bg_cells: Vec<(usize, usize, usize, Rgb8)> = Vec::new();
        let mut runs: Vec<(usize, CellRun)> = Vec::new();

        for indexed in content.display_iter {
            let pt = indexed.point;
            let cell = indexed.cell;
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                continue;
            }
            let row = (pt.line.0 + offset) as usize;
            let col = pt.column.0;
            let wide = cell.flags.contains(Flags::WIDE_CHAR);
            let cells = if wide { 2 } else { 1 };

            let mut fg = palette.resolve_fg(cell.fg, cell.flags.contains(Flags::BOLD), overrides);
            let mut bg = palette.resolve(cell.bg, overrides);
            if cell.flags.contains(Flags::INVERSE) {
                std::mem::swap(&mut fg, &mut bg);
            }
            if cell.flags.contains(Flags::DIM) {
                fg = dim_rgb8(fg, bg);
            }
            let selected = selection.is_some_and(|s| {
                s.contains(pt) || (wide && s.contains(GridPoint::new(pt.line, pt.column + 1)))
            });
            if selected {
                bg = palette.selection;
            }
            if cell.flags.contains(Flags::HIDDEN) {
                fg = bg;
            }
            if solid_cursor && pt == cursor.point {
                bg = palette.cursor;
                fg = default_bg;
            }
            if bg != default_bg {
                push_bg_run(row, col, cells, bg, &mut bg_cells);
            }

            let ch_char =
                if cell.c.is_control() || cell.flags.contains(Flags::LEADING_WIDE_CHAR_SPACER) {
                    ' '
                } else {
                    cell.c
                };
            let bold = cell.flags.contains(Flags::BOLD);
            let italic = cell.flags.contains(Flags::ITALIC);
            let underline = cell.flags.intersects(Flags::ALL_UNDERLINES);
            let strike = cell.flags.contains(Flags::STRIKEOUT);

            let can_extend = runs.last().is_some_and(|(r, run)| {
                *r == row
                    && run.column + run.cells == col
                    && run.matches(fg, bold, italic, underline, strike)
                    && !wide
            });
            if !can_extend {
                runs.push((
                    row,
                    CellRun {
                        column: col,
                        cells: 0,
                        text: String::new(),
                        color: fg,
                        bold,
                        italic,
                        underline,
                        strike,
                        wide,
                    },
                ));
            }
            if let Some((_, run)) = runs.last_mut() {
                run.text.push(ch_char);
                for extra in cell.zerowidth().into_iter().flatten() {
                    run.text.push(*extra);
                }
                run.cells += cells;
            }
        }

        let backgrounds: Vec<(Bounds<Pixels>, Hsla)> = bg_cells
            .into_iter()
            .map(|(row, col, cells, color)| (cell_rect(col, row, cells), rgb8_to_hsla(color)))
            .collect();

        let cursor_hsla = rgb8_to_hsla(palette.cursor);
        let cursor_paint = if !cursor_visible {
            None
        } else if solid_cursor {
            Some(CursorPaint::Block)
        } else {
            let rect = cell_rect(cursor.point.column.0, cursor_row as usize, 1);
            match cursor.shape {
                CursorShape::Beam => Some(CursorPaint::Bar(
                    Bounds {
                        origin: rect.origin,
                        size: size(px(2.0), rect.size.height),
                    },
                    cursor_hsla,
                )),
                CursorShape::Underline => Some(CursorPaint::Bar(
                    Bounds {
                        origin: point(rect.origin.x, rect.origin.y + rect.size.height - px(2.0)),
                        size: size(rect.size.width, px(2.0)),
                    },
                    cursor_hsla,
                )),
                _ => Some(CursorPaint::Outline(rect, cursor_hsla)),
            }
        };
        drop(term);

        let text_sys = window.text_system().clone();
        let mut lines = Vec::with_capacity(runs.len());
        for (row, run) in runs {
            if !run.underline && !run.strike && run.text.chars().all(|c| c == ' ') {
                continue;
            }
            let mut f = m.font.clone();
            if run.bold {
                f = f.bold();
            }
            if run.italic {
                f = f.italic();
            }
            let color = rgb8_to_hsla(run.color);
            let style = TextRun {
                len: run.text.len(),
                font: f,
                color,
                background_color: None,
                underline: run.underline.then_some(UnderlineStyle {
                    thickness: px(1.0),
                    color: Some(color),
                    wavy: false,
                }),
                strikethrough: run.strike.then_some(StrikethroughStyle {
                    thickness: px(1.0),
                    color: Some(color),
                }),
            };
            let force_width = (!run.wide).then_some(px(cw));
            let shaped = text_sys.shape_line(run.text.into(), m.size, &[style], force_width);
            lines.push((cell_rect(run.column, row, 1).origin, shaped));
        }

        PrepaintedTerminal {
            backgrounds,
            lines,
            cursor: cursor_paint,
            hitbox,
            cell_height: px(ch),
        }
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        prepainted: &mut PrepaintedTerminal,
        window: &mut Window,
        cx: &mut App,
    ) {
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            for (rect, color) in &prepainted.backgrounds {
                window.paint_quad(fill(*rect, *color));
            }
            for (origin, line) in &prepainted.lines {
                let _ = line.paint(
                    *origin,
                    prepainted.cell_height,
                    TextAlign::Left,
                    None,
                    window,
                    cx,
                );
            }
            match &prepainted.cursor {
                Some(CursorPaint::Outline(rect, color)) => {
                    window.paint_quad(outline(*rect, *color, BorderStyle::Solid));
                }
                Some(CursorPaint::Bar(rect, color)) => {
                    window.paint_quad(fill(*rect, *color));
                }
                Some(CursorPaint::Block) | None => {}
            }
        });

        let focus = self.panel.read(cx).focus.clone();
        window.handle_input(
            &focus,
            ElementInputHandler::new(bounds, self.panel.clone()),
            cx,
        );
        window.set_cursor_style(CursorStyle::IBeam, &prepainted.hitbox);

        let (panel, hitbox) = (self.panel.clone(), prepainted.hitbox.clone());
        window.on_mouse_event(move |event: &MouseDownEvent, phase, window, cx| {
            if phase == DispatchPhase::Bubble && hitbox.is_hovered(window) {
                panel.update(cx, |p, cx| p.mouse_down(event, window, cx));
                cx.stop_propagation();
            }
        });
        let panel = self.panel.clone();
        window.on_mouse_event(move |event: &MouseMoveEvent, phase, _window, cx| {
            if phase == DispatchPhase::Bubble {
                panel.update(cx, |p, cx| p.mouse_moved(event, cx));
            }
        });
        let panel = self.panel.clone();
        window.on_mouse_event(move |event: &MouseUpEvent, phase, _window, cx| {
            if phase == DispatchPhase::Bubble {
                panel.update(cx, |p, cx| p.mouse_up(event, cx));
            }
        });
        let (panel, hitbox) = (self.panel.clone(), prepainted.hitbox.clone());
        window.on_mouse_event(move |event: &ScrollEvent, phase, window, cx| {
            if phase == DispatchPhase::Bubble && hitbox.should_handle_scroll(window) {
                panel.update(cx, |p, cx| p.scrolled(event, cx));
            }
        });
    }
}

/// Maps a window point to a `(col, row, Side)` cell inside the terminal viewport.
fn map_point_to_cell(
    position: Point<Pixels>,
    drawn_at: DrawnAt,
    grid: GridSize,
    clamp: bool,
) -> Option<(usize, usize, Side)> {
    let x = f32::from(position.x - drawn_at.origin.x);
    let y = f32::from(position.y - drawn_at.origin.y);
    let (w, h) = (
        f32::from(drawn_at.cell_width),
        f32::from(drawn_at.cell_height),
    );
    let (cols, rows) = (f32::from(grid.cols), f32::from(grid.rows));
    if !clamp && (x < 0.0 || y < 0.0 || x >= w * cols || y >= h * rows) {
        return None;
    }
    let col = (x / w).floor().clamp(0.0, (cols - 1.0).max(0.0));
    let row = (y / h).floor().clamp(0.0, (rows - 1.0).max(0.0));
    let side = if x - col * w < w / 2.0 {
        Side::Left
    } else {
        Side::Right
    };
    Some((col as usize, row as usize, side))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_point_to_cell_resolves_cell_side_and_clamps_drags() {
        let drawn = DrawnAt {
            origin: point(px(16.0), px(20.0)),
            cell_width: px(8.0),
            cell_height: px(18.0),
        };
        let grid = GridSize {
            cols: 10,
            rows: 4,
            cell_width: 8.0,
            cell_height: 18.0,
        };
        assert_eq!(
            map_point_to_cell(point(px(10.0), px(25.0)), drawn, grid, false),
            None
        );
        assert_eq!(
            map_point_to_cell(point(px(17.0), px(21.0)), drawn, grid, false),
            Some((0, 0, Side::Left))
        );
        assert_eq!(
            map_point_to_cell(point(px(22.0), px(21.0)), drawn, grid, false),
            Some((0, 0, Side::Right))
        );
        assert_eq!(
            map_point_to_cell(
                point(px(16.0 + 3.0 * 8.0 + 2.0), px(20.0 + 2.0 * 18.0 + 5.0)),
                drawn,
                grid,
                false
            ),
            Some((3, 2, Side::Left))
        );
        // Drag outside bounds clamps cleanly to the edges.
        assert_eq!(
            map_point_to_cell(point(px(500.0), px(500.0)), drawn, grid, true),
            Some((9, 3, Side::Right))
        );
        assert_eq!(
            map_point_to_cell(point(px(-50.0), px(-50.0)), drawn, grid, true),
            Some((0, 0, Side::Left))
        );
    }
}
