//! Conn chat card view: messages timeline, collapsible thinking/tool rows,
//! working indicator, empty state, and bottom composer.

mod cache;
mod color;
mod composer;
mod icons;
pub(crate) mod markdown;
mod spinner;

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::rc::Rc;

use conn_state::{
    EntryTiming, ItemStatus, RunTiming, ThreadState, TimelineEntry, TurnCheckpointSummary,
};
use conn_theme::Tokens;
use gpui_kit::{
    AnyElement, AppContext as _, Context, Entity, EventEmitter, FontWeight, InteractiveElement,
    IntoElement, ParentElement, Render, ScrollHandle, SharedString, StatefulInteractiveElement,
    Styled, Subscription, Window, div, px, relative,
};

use self::cache::{CachedRow, RowCache, TimelineItem, group_rows};
use self::color::{hsla, message_highlight, muted_icon, prose_foreground};
use self::composer::{Composer, ComposerEvent};
use self::spinner::TurningArc;

/// Centered chat content lane width matching Conn's `--chat-content-max-width` (`46rem`).
const CHAT_CONTENT_MAX_WIDTH_PX: f32 = 736.0;
/// Horizontal lane padding matching `.chat-composer-lane` / `.messages-timeline-scroll` (`3rem`).
const CHAT_LANE_PADDING_X_PX: f32 = 48.0;
/// User bubble radius matching Conn's `--radius-bubble: calc(var(--radius) + 6px)` (`8px + 6px`).
const BUBBLE_RADIUS_PX: f32 = 14.0;
/// Tight corner radius where consecutive user bubbles meet (`rounded-tr-md` / `rounded-br-md`).
const BUBBLE_GROUPED_RADIUS_PX: f32 = 6.0;
/// Distance from the bottom edge (in px) within which auto-follow stays engaged.
const STICK_TO_BOTTOM_THRESHOLD_PX: f32 = 24.0;
/// Body text typography matching Conn's `text-sm leading-relaxed` (`14px` / `22.75px`).
const BODY_FONT_PX: f32 = 14.0;
const BODY_LINE_HEIGHT_PX: f32 = 22.75;
/// Standard panel chrome typography (`text-ui`: `13px` / `20px`).
const UI_FONT_PX: f32 = 13.0;
const UI_LINE_HEIGHT_PX: f32 = 20.0;
const MONO_FONT_FAMILY: &str = crate::theme::MONO_FONT;

/// Events emitted by [`ChatView`] to the host shell.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ChatEvent {
    Send {
        text: String,
        attachments: Vec<conn_contract::ChatAttachment>,
    },
    Stop,
    /// Answer an approval row: `decision` is `accept` or `decline`.
    Approval {
        entry_id: String,
        decision: String,
    },
    ModelSelected {
        instance_id: String,
        model: String,
    },
    /// Open the right panel's Diff tab (e.g. clicking a turn's changed-files summary card).
    OpenDiff,
    /// Open a workspace-relative file in the right panel's File preview tab.
    OpenFile(String),
    /// A built-in `/` slash command selected from the composer command menu.
    SlashCommand(String),
}

/// GPUI entity rendering the Conn chat card (timeline + composer).
pub(crate) struct ChatView {
    tokens: Tokens,
    has_thread: bool,
    thread_id: Option<String>,
    thread_title: Option<String>,
    working: bool,
    cache: RowCache,
    entry_timings: HashMap<String, EntryTiming>,
    run_timings: HashMap<String, RunTiming>,
    turn_checkpoints: HashMap<String, TurnCheckpointSummary>,
    expanded_ids: HashSet<String>,
    wrapped_code_keys: HashSet<String>,
    copied_code_key: Option<String>,
    model_label: String,
    /// Project root; tool row paths under it show relative, as in Conn.
    workspace_root: Option<String>,
    scroll_handle: ScrollHandle,
    stick_to_bottom: bool,
    composer: Entity<Composer>,
    _input_sub: Subscription,
}

impl fmt::Debug for ChatView {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ChatView")
            .field("has_thread", &self.has_thread)
            .field("thread_id", &self.thread_id)
            .field("working", &self.working)
            .field("row_count", &self.cache.rows().len())
            .field("model_label", &self.model_label)
            .finish_non_exhaustive()
    }
}

impl EventEmitter<ChatEvent> for ChatView {}

impl ChatView {
    /// Creates a new [`ChatView`] styled with `tokens`.
    pub(crate) fn new(
        tokens: Tokens,
        connection: Option<conn_client::Connection>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Self {
        let composer = cx.new(|cx| Composer::new(tokens.clone(), connection, window, cx));
        let input_sub = cx.subscribe(
            &composer,
            |this, _, event: &ComposerEvent, cx| match event {
                ComposerEvent::Send { text, attachments } => {
                    this.stick_to_bottom = true;
                    cx.emit(ChatEvent::Send {
                        text: text.clone(),
                        attachments: attachments.clone(),
                    });
                    cx.notify();
                }
                ComposerEvent::Stop => cx.emit(ChatEvent::Stop),
                ComposerEvent::ModelSelected { instance_id, model } => {
                    cx.emit(ChatEvent::ModelSelected {
                        instance_id: instance_id.clone(),
                        model: model.clone(),
                    });
                }
                ComposerEvent::SlashCommand(command) => {
                    cx.emit(ChatEvent::SlashCommand(command.clone()));
                }
            },
        );

        Self {
            tokens,
            has_thread: false,
            thread_id: None,
            thread_title: None,
            working: false,
            cache: RowCache::default(),
            entry_timings: HashMap::new(),
            run_timings: HashMap::new(),
            turn_checkpoints: HashMap::new(),
            expanded_ids: HashSet::new(),
            wrapped_code_keys: HashSet::new(),
            copied_code_key: None,
            model_label: "Default model".to_owned(),
            workspace_root: None,
            scroll_handle: ScrollHandle::new(),
            stick_to_bottom: true,
            composer,
            _input_sub: input_sub,
        }
    }

    /// Replaces the active theme tokens and triggers a repaint.
    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        if self.tokens == tokens {
            return;
        }
        self.composer
            .update(cx, |c, cx| c.set_tokens(tokens.clone(), cx));
        self.tokens = tokens;
        cx.notify();
    }

    /// Updates the rendered thread state.
    ///
    /// Cheap to call on every streaming update: parsed Markdown blocks are cached by entry id
    /// and only re-parsed when an assistant entry's text changes.
    pub(crate) fn set_thread(
        &mut self,
        thread: Option<&ThreadState>,
        title: Option<String>,
        cx: &mut Context<'_, Self>,
    ) {
        self.refresh_stick_to_bottom();
        self.thread_title = title;

        let Some(thread) = thread else {
            self.has_thread = false;
            self.thread_id = None;
            self.working = false;
            self.cache.clear();
            self.entry_timings.clear();
            self.run_timings.clear();
            self.turn_checkpoints.clear();
            self.expanded_ids.clear();
            self.wrapped_code_keys.clear();
            self.copied_code_key = None;
            self.stick_to_bottom = true;
            cx.notify();
            return;
        };

        let switched_thread = self.thread_id.as_deref() != Some(thread.thread_id.as_str());
        if switched_thread {
            self.thread_id = Some(thread.thread_id.clone());
            self.expanded_ids.clear();
            self.wrapped_code_keys.clear();
            self.copied_code_key = None;
            self.stick_to_bottom = true;
        }

        self.has_thread = true;
        self.working = thread.working;
        self.entry_timings = thread.entry_timings.clone();
        self.run_timings = thread.run_timings.clone();
        self.turn_checkpoints = thread.turn_checkpoints.clone();
        let _stats = self.cache.sync(&thread.entries);

        if self.stick_to_bottom {
            self.scroll_handle.scroll_to_bottom();
        }
        cx.notify();
        let working = self.working;
        self.composer.update(cx, |c, cx| c.set_working(working, cx));
    }

    /// Sets the model display label shown in the composer footer.
    /// Sets the project root used to shorten tool row paths.
    pub(crate) fn set_workspace_root(&mut self, root: Option<String>, cx: &mut Context<'_, Self>) {
        if self.workspace_root != root {
            self.composer
                .update(cx, |c, cx| c.set_workspace_root(root.clone(), cx));
            self.workspace_root = root;
            cx.notify();
        }
    }

    /// `Read /private/tmp/x/src/main.rs` → `Read src/main.rs` under root `/tmp/x`.
    fn relative_title(&self, title: &str) -> String {
        let Some(root) = self.workspace_root.as_deref() else {
            return title.to_owned();
        };
        let root = root.trim_end_matches('/');
        let private = format!("/private{root}");
        title
            .replace(&format!("{private}/"), "")
            .replace(&format!("{root}/"), "")
    }

    pub(crate) fn set_model_label(&mut self, label: String, cx: &mut Context<'_, Self>) {
        if self.model_label == label {
            return;
        }
        self.composer
            .update(cx, |c, cx| c.set_model_label(label.clone(), cx));
        self.model_label = label;
        cx.notify();
    }

    pub(super) fn mark_code_copied(&mut self, key: String, cx: &mut Context<'_, Self>) {
        self.copied_code_key = Some(key);
        cx.notify();
    }

    pub(super) fn toggle_code_wrap(&mut self, key: String, cx: &mut Context<'_, Self>) {
        if !self.wrapped_code_keys.remove(&key) {
            self.wrapped_code_keys.insert(key);
        }
        cx.notify();
    }

    fn toggle_expanded(&mut self, id: &str, cx: &mut Context<'_, Self>) {
        if !self.expanded_ids.remove(id) {
            self.expanded_ids.insert(id.to_owned());
        }
        cx.notify();
    }

    fn work_group_duration_ms(&self, rows: &[CachedRow]) -> Option<u64> {
        let mut min_start: Option<i64> = None;
        let mut max_end: Option<i64> = None;
        let mut single_run: Option<&str> = None;
        let mut multiple_runs = false;
        for row in rows {
            if let Some(timing) = self.entry_timings.get(row.entry.id()) {
                if let Some(start) = timing.started_at_ms {
                    min_start = Some(min_start.map_or(start, |cur| cur.min(start)));
                }
                if let Some(end) = timing.completed_at_ms {
                    max_end = Some(max_end.map_or(end, |cur| cur.max(end)));
                }
                if let Some(run_id) = timing.run_id.as_deref() {
                    match single_run {
                        None => single_run = Some(run_id),
                        Some(existing) if existing != run_id => multiple_runs = true,
                        Some(_) => {}
                    }
                }
            }
        }
        if let (Some(start), Some(end)) = (min_start, max_end)
            && end > start
        {
            return u64::try_from(end - start).ok();
        }
        if !multiple_runs
            && let Some(run_id) = single_run
            && let Some(run) = self.run_timings.get(run_id)
            && let (Some(start), Some(end)) = (run.started_at_ms, run.completed_at_ms)
            && end > start
        {
            return u64::try_from(end - start).ok();
        }
        None
    }

    fn item_run_id(&self, item: &TimelineItem<'_>) -> Option<&str> {
        let id = match item {
            TimelineItem::User { row, .. }
            | TimelineItem::Assistant { row, .. }
            | TimelineItem::Approval(row)
            | TimelineItem::Notice(row) => row.entry.id(),
            TimelineItem::WorkGroup { rows, .. } => rows.last()?.entry.id(),
        };
        self.entry_timings.get(id).and_then(|t| t.run_id.as_deref())
    }

    fn checkpoint_after_item(
        &self,
        items: &[TimelineItem<'_>],
        idx: usize,
    ) -> Option<&TurnCheckpointSummary> {
        let item = items.get(idx)?;
        if matches!(item, TimelineItem::User { .. }) {
            return None;
        }
        let run_id = self.item_run_id(item)?;
        // Only emit after the final non-user item belonging to this run.
        let next_same_run = items
            .get(idx + 1)
            .and_then(|next| self.item_run_id(next))
            .is_some_and(|next_id| next_id == run_id);
        if next_same_run {
            return None;
        }
        self.turn_checkpoints
            .get(run_id)
            .filter(|cp| cp.file_count > 0)
    }

    fn render_changed_files_card(
        &self,
        idx: usize,
        cp: &TurnCheckpointSummary,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let label = if cp.file_count == 1 {
            "1 changed file".to_owned()
        } else {
            format!("{} changed files", cp.file_count)
        };
        let border = hsla(self.tokens.shell_divider);
        let hover_bg = hsla(self.tokens.shell_highlight);
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground);
        let added = hsla(self.tokens.diff_added);
        let removed = hsla(self.tokens.diff_removed);

        div()
            .pt(px(6.0))
            .pb(px(4.0))
            .child(
                div()
                    .id(SharedString::from(format!("turn-changed-files-{idx}")))
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .gap(px(8.0))
                    .w_full()
                    .px(px(12.0))
                    .py(px(8.0))
                    .rounded(px(10.0))
                    .bg(hsla(self.tokens.shell_field))
                    .border_1()
                    .border_color(border)
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover_bg))
                    .on_click(cx.listener(|_, _, _, cx| {
                        cx.emit(ChatEvent::OpenDiff);
                    }))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(8.0))
                            .child(icons::icon("superhero/file-diff.svg", 14.0, muted))
                            .child(
                                div()
                                    .text_size(px(UI_FONT_PX))
                                    .line_height(px(UI_LINE_HEIGHT_PX))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(fg)
                                    .child(label),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(8.0))
                            .text_size(px(UI_FONT_PX))
                            .line_height(px(UI_LINE_HEIGHT_PX))
                            .child(div().text_color(added).child(format!("+{}", cp.additions)))
                            .child(
                                div()
                                    .text_color(removed)
                                    .child(format!("-{}", cp.deletions)),
                            )
                            .child(icons::icon(icons::CARET_RIGHT, 12.0, muted)),
                    ),
            )
            .into_any_element()
    }

    fn refresh_stick_to_bottom(&mut self) {
        let max_y = f32::from(self.scroll_handle.max_offset().y);
        if max_y <= 0.0 {
            self.stick_to_bottom = true;
            return;
        }
        // GPUI scroll offset.y is <= 0.0 (0 at top, -max_y at bottom).
        let current_y = -f32::from(self.scroll_handle.offset().y);
        let distance_from_bottom = (max_y - current_y).max(0.0);
        self.stick_to_bottom = distance_from_bottom <= STICK_TO_BOTTOM_THRESHOLD_PX;
    }

    fn render_empty_no_thread(&self) -> AnyElement {
        div()
            .flex()
            .flex_1()
            .size_full()
            .items_center()
            .justify_center()
            .px(px(32.0))
            .py(px(48.0))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(12.0))
                    .max_w(px(420.0))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_center()
                            .size(px(44.0))
                            .rounded(px(12.0))
                            .bg(hsla(self.tokens.shell_tile))
                            .border_1()
                            .border_color(hsla(self.tokens.shell_tile_border))
                            .child(icons::icon(
                                icons::CHAT_CIRCLE,
                                20.0,
                                hsla(self.tokens.muted_foreground),
                            )),
                    )
                    .child(
                        div()
                            .text_size(px(15.0))
                            .line_height(px(22.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(hsla(self.tokens.foreground))
                            .child("Pick a thread to continue"),
                    )
                    .child(
                        div()
                            .text_size(px(UI_FONT_PX))
                            .line_height(px(UI_LINE_HEIGHT_PX))
                            .text_color(hsla(self.tokens.muted_foreground))
                            .child("Select an existing thread or create a new one to get started."),
                    ),
            )
            .into_any_element()
    }

    fn render_timeline_item(
        &self,
        item: &TimelineItem<'_>,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        match item {
            TimelineItem::User {
                row,
                grouped_with_previous,
                grouped_with_next,
            } => {
                if let TimelineEntry::User {
                    id,
                    text,
                    created_by_agent,
                } = &row.entry
                {
                    if *created_by_agent {
                        self.render_agent_prompt_row(id, text, cx)
                    } else {
                        self.render_user_bubble(text, *grouped_with_previous, *grouped_with_next)
                    }
                } else {
                    div().into_any_element()
                }
            }
            TimelineItem::Assistant {
                row,
                followed_by_work,
            } => {
                if let TimelineEntry::Assistant { id, .. } = &row.entry {
                    let blocks = row.blocks.as_deref().unwrap_or(&[]);
                    let entity_copy = cx.entity().downgrade();
                    let entity_wrap = cx.entity().downgrade();
                    let entity_file = cx.entity().downgrade();
                    let options = markdown::MarkdownOptions {
                        heading_style: markdown::HeadingStyle::Scale,
                        copied_code_key: self.copied_code_key.as_deref(),
                        on_copy_code: Some(Rc::new(move |key, _window, cx| {
                            let _ =
                                entity_copy.update(cx, |view, cx| view.mark_code_copied(key, cx));
                        })),
                        wrapped_code_keys: Some(&self.wrapped_code_keys),
                        on_toggle_wrap_code: Some(Rc::new(move |key, _window, cx| {
                            let _ =
                                entity_wrap.update(cx, |view, cx| view.toggle_code_wrap(key, cx));
                        })),
                        workspace_root: self.workspace_root.as_deref(),
                        on_open_file: Some(Rc::new(move |path, _window, cx| {
                            let _ = entity_file.update(cx, |_view, cx| {
                                cx.emit(ChatEvent::OpenFile(path));
                            });
                        })),
                    };
                    // Conn `AssistantTimelineRow`: `px-1 py-0.5`, row spacing `pb-2` before work or `pb-4`.
                    div()
                        .w_full()
                        .min_w_0()
                        .pb(px(if *followed_by_work { 8.0 } else { 16.0 }))
                        .child(
                            div()
                                .w_full()
                                .min_w_0()
                                .px(px(4.0))
                                .py(px(2.0))
                                .child(markdown::render_blocks(id, blocks, &self.tokens, &options)),
                        )
                        .into_any_element()
                } else {
                    div().into_any_element()
                }
            }
            TimelineItem::WorkGroup {
                id,
                rows,
                has_active,
            } => self.render_work_group(id, rows, *has_active, cx),
            TimelineItem::Approval(row) => {
                if let TimelineEntry::Approval { id, title, detail } = &row.entry {
                    self.render_approval_row(id, title, detail.as_deref(), cx)
                } else {
                    div().into_any_element()
                }
            }
            TimelineItem::Notice(row) => {
                if let TimelineEntry::Notice { text, is_error, .. } = &row.entry {
                    self.render_notice_row(text, *is_error)
                } else {
                    div().into_any_element()
                }
            }
        }
    }

    fn render_user_bubble(
        &self,
        text: &str,
        grouped_with_previous: bool,
        grouped_with_next: bool,
    ) -> AnyElement {
        // Conn `TimelineUserMessageRow`: `max-w-[80%] rounded-bubble border-t border-t-(--message-highlight)!
        // bg-message text-message-foreground px-4 pt-2.5 pb-3 text-sm leading-relaxed`.
        let mut bubble = div()
            .max_w(relative(0.8))
            .min_w_0()
            .rounded(px(BUBBLE_RADIUS_PX))
            .bg(hsla(self.tokens.message_surface))
            .border_t_1()
            .border_color(message_highlight(&self.tokens))
            .px(px(16.0))
            .pt(px(10.0))
            .pb(px(12.0))
            .text_size(px(BODY_FONT_PX))
            .line_height(px(BODY_LINE_HEIGHT_PX))
            .text_color(hsla(self.tokens.message_foreground))
            .child(text.to_owned());

        if grouped_with_previous {
            bubble = bubble.rounded_tr(px(BUBBLE_GROUPED_RADIUS_PX));
        }
        if grouped_with_next {
            bubble = bubble.rounded_br(px(BUBBLE_GROUPED_RADIUS_PX));
        }

        div()
            .flex()
            .flex_row()
            .justify_end()
            .w_full()
            .pb(px(if grouped_with_next { 4.0 } else { 16.0 }))
            .child(bubble)
            .into_any_element()
    }

    /// Renders a thread-opening or delegated prompt sent by an agent/CLI as Conn's collapsed
    /// `"Agent <single-line preview> ▸"` row, expanding on click to show the full text.
    fn render_agent_prompt_row(
        &self,
        id: &str,
        text: &str,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let key = format!("agent-msg-{id}");
        let expanded = self.expanded_ids.contains(&key);
        let toggle_key = key.clone();
        let preview = text
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or("Prompt");
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground);

        let mut col = div()
            .flex()
            .flex_col()
            .w_full()
            .min_w_0()
            .pb(px(12.0))
            .child(
                div()
                    .id(SharedString::from(key))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .w_full()
                    .min_w_0()
                    .px(px(4.0))
                    .py(px(2.0))
                    .rounded(px(6.0))
                    .cursor_pointer()
                    .text_size(px(UI_FONT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .hover(move |s| s.text_color(fg))
                    .on_click(cx.listener(move |view, _, _, cx| {
                        view.toggle_expanded(&toggle_key, cx);
                    }))
                    .child(icons::icon("superhero/agent.svg", 14.0, muted))
                    .child(
                        div()
                            .flex_shrink_0()
                            .font_weight(FontWeight::MEDIUM)
                            .child("Agent"),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .child(preview.to_owned()),
                    )
                    .child(icons::icon(
                        if expanded {
                            "superhero/chevron-down.svg"
                        } else {
                            "superhero/chevron-right.svg"
                        },
                        13.0,
                        muted,
                    )),
            );

        if expanded {
            col = col.child(
                div()
                    .mt(px(4.0))
                    .ml(px(20.0))
                    .px(px(12.0))
                    .py(px(8.0))
                    .rounded(px(10.0))
                    .bg(hsla(self.tokens.shell_control))
                    .border_1()
                    .border_color(hsla(self.tokens.shell_inner_border))
                    .text_size(px(UI_FONT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(prose_foreground(&self.tokens))
                    .child(text.to_owned()),
            );
        }

        col.into_any_element()
    }

    /// Renders a turn's grouped thinking/tool work entries.
    ///
    /// Settled groups collapse under Conn's `"Worked"` toggle header with a chevron and
    /// full-width divider (`TurnFoldTimelineRow`). Active groups render their rows live.
    fn render_work_group(
        &self,
        group_id: &str,
        rows: &[CachedRow],
        has_active: bool,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let expanded = has_active || self.expanded_ids.contains(group_id);
        let toggle_id = group_id.to_owned();

        let mut container = div().flex().flex_col().w_full().min_w_0();

        if !has_active {
            // Conn `TurnFoldTimelineRow`: `border-b border-(--shell-divider)! pb-2 pt-1`,
            // button `flex items-center gap-1 rounded-md px-1 text-sm leading-relaxed
            // text-muted-foreground hover:text-foreground`, `size-3.5` (14px) chevron.
            let duration_ms = self.work_group_duration_ms(rows);
            let worked_label = format_worked_label(duration_ms);
            let fold_btn = div()
                .id(SharedString::from(format!("fold-{group_id}")))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(4.0))
                .px(px(4.0))
                .rounded(px(6.0))
                .cursor_pointer()
                .text_size(px(BODY_FONT_PX))
                .line_height(px(BODY_LINE_HEIGHT_PX))
                .text_color(hsla(self.tokens.muted_foreground))
                .hover(|s| s.text_color(hsla(self.tokens.foreground)))
                .on_click(cx.listener(move |view, _, _, cx| {
                    view.toggle_expanded(&toggle_id, cx);
                }))
                .child(worked_label)
                .child(icons::icon(
                    if expanded {
                        icons::CARET_DOWN
                    } else {
                        icons::CARET_RIGHT
                    },
                    14.0,
                    hsla(self.tokens.muted_foreground),
                ));

            let header = div()
                .w_full()
                .min_w_0()
                .pt(px(4.0))
                .pb(px(8.0))
                .border_b_1()
                .border_color(hsla(self.tokens.shell_divider))
                .child(div().flex().flex_row().items_center().child(fold_btn));

            container = container.child(header);
        }

        if expanded {
            let mut list = div()
                .flex()
                .flex_col()
                .w_full()
                .min_w_0()
                .pt(px(if has_active { 0.0 } else { 4.0 }));
            for row in rows {
                list = list.child(self.render_work_entry(row, cx));
            }
            container = container.pb(px(8.0)).child(list);
        } else {
            // Conn `turn-fold` row spacing: `pb-1.5` (6px).
            container = container.pb(px(6.0));
        }

        container.into_any_element()
    }

    fn render_work_entry(&self, row: &CachedRow, cx: &mut Context<'_, Self>) -> AnyElement {
        match &row.entry {
            TimelineEntry::Thinking {
                id,
                text,
                streaming,
            } => self.render_thinking_row(id, text, *streaming, cx),
            TimelineEntry::Tool {
                id,
                kind,
                title,
                detail,
                status,
            } => {
                let title = self.relative_title(title);
                self.render_tool_row(id, kind, &title, detail.as_deref(), *status, cx)
            }
            _ => div().into_any_element(),
        }
    }

    fn render_thinking_row(
        &self,
        id: &str,
        text: &str,
        streaming: bool,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let expanded = self.expanded_ids.contains(id);
        let toggle_id = id.to_owned();
        let trimmed = text.trim();
        let has_body = !trimmed.is_empty();
        let preview_line = trimmed
            .lines()
            .find(|line| !line.trim().is_empty())
            .map(str::trim);
        let label = if expanded || preview_line.is_none() {
            if streaming { "Thinking" } else { "Thought" }.to_owned()
        } else {
            preview_line.unwrap_or("Thought").to_owned()
        };

        let leading: AnyElement = if streaming {
            TurningArc::new(14.0, hsla(self.tokens.muted_foreground)).into_any_element()
        } else {
            icons::icon(icons::BRAIN, 16.0, muted_icon(&self.tokens)).into_any_element()
        };

        // Conn `WorkLogRow`: `min-h-6` (24px), `gap-1.5` (6px), `px-0.5`, `24px` icon box, `text-sm leading-relaxed`.
        let mut line = div()
            .id(SharedString::from(format!("thinking-{id}")))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .w_full()
            .min_w_0()
            .min_h(px(24.0))
            .px(px(2.0))
            .rounded(px(6.0))
            .cursor_pointer()
            .text_size(px(BODY_FONT_PX))
            .line_height(px(BODY_LINE_HEIGHT_PX))
            .text_color(if streaming {
                prose_foreground(&self.tokens)
            } else {
                hsla(self.tokens.muted_foreground)
            })
            .hover(|s| s.text_color(hsla(self.tokens.foreground)))
            .on_click(cx.listener(move |view, _, _, cx| {
                view.toggle_expanded(&toggle_id, cx);
            }))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(24.0))
                    .flex_none()
                    .child(leading),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .child(label),
            );

        if has_body {
            line = line.child(
                div()
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(16.0))
                    .flex_none()
                    .child(icons::icon(
                        if expanded {
                            icons::CARET_DOWN
                        } else {
                            icons::CARET_RIGHT
                        },
                        12.0,
                        muted_icon(&self.tokens),
                    )),
            );
        }

        let mut container = div().flex().flex_col().w_full().min_w_0().child(line);
        if expanded && has_body {
            // Conn `WorkLogDetails kind="text"`: `ms-7` (28px), `px-0.5 py-1`.
            container = container.child(
                div()
                    .ml(px(28.0))
                    .px(px(2.0))
                    .py(px(4.0))
                    .text_size(px(BODY_FONT_PX))
                    .line_height(px(BODY_LINE_HEIGHT_PX))
                    .text_color(prose_foreground(&self.tokens))
                    .child(trimmed.to_owned()),
            );
        }
        container.into_any_element()
    }

    fn render_tool_row(
        &self,
        id: &str,
        kind: &str,
        title: &str,
        detail: Option<&str>,
        status: ItemStatus,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let expanded = self.expanded_ids.contains(id);
        let toggle_id = id.to_owned();
        let has_detail = detail.is_some_and(|d| !d.trim().is_empty());

        let (icon_color, title_color) = match status {
            ItemStatus::Failed => (hsla(self.tokens.destructive), hsla(self.tokens.destructive)),
            ItemStatus::Running => (muted_icon(&self.tokens), prose_foreground(&self.tokens)),
            ItemStatus::Completed => (muted_icon(&self.tokens), hsla(self.tokens.muted_foreground)),
        };

        let leading: AnyElement = match status {
            ItemStatus::Running => {
                TurningArc::new(14.0, hsla(self.tokens.muted_foreground)).into_any_element()
            }
            ItemStatus::Failed => {
                icons::icon(icons::ERROR_CIRCLE, 16.0, icon_color).into_any_element()
            }
            ItemStatus::Completed => {
                icons::icon(icons::tool_icon_path(kind), 16.0, icon_color).into_any_element()
            }
        };

        // Conn `WorkLogRow`: `min-h-6` (24px), `gap-1.5` (6px), `px-0.5`, `24px` icon box, `text-sm leading-relaxed`.
        let mut line = div()
            .id(SharedString::from(format!("tool-{id}")))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .w_full()
            .min_w_0()
            .min_h(px(24.0))
            .px(px(2.0))
            .rounded(px(6.0))
            .text_size(px(BODY_FONT_PX))
            .line_height(px(BODY_LINE_HEIGHT_PX))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(24.0))
                    .flex_none()
                    .child(leading),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .text_color(title_color)
                    .child(title.to_owned()),
            );

        if has_detail {
            line = line
                .cursor_pointer()
                .hover(|s| s.text_color(hsla(self.tokens.foreground)))
                .on_click(cx.listener(move |view, _, _, cx| {
                    view.toggle_expanded(&toggle_id, cx);
                }))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_center()
                        .size(px(16.0))
                        .flex_none()
                        .child(icons::icon(
                            if expanded {
                                icons::CARET_DOWN
                            } else {
                                icons::CARET_RIGHT
                            },
                            12.0,
                            muted_icon(&self.tokens),
                        )),
                );
        }

        let mut container = div().flex().flex_col().w_full().min_w_0().child(line);
        if expanded && let Some(detail_text) = detail.filter(|d| !d.trim().is_empty()) {
            // Conn `WorkLogDetails kind="panel"` + `toolCallExpandedBodyClassName`:
            // indented under label (`30px`), monospace `11.5px` / `18px`, `muted_foreground`.
            container = container.child(
                div()
                    .ml(px(30.0))
                    .mt(px(2.0))
                    .mb(px(6.0))
                    .px(px(10.0))
                    .py(px(8.0))
                    .rounded(px(8.0))
                    .bg(hsla(self.tokens.code_background))
                    .border_1()
                    .border_color(hsla(self.tokens.shell_divider))
                    .font_family(MONO_FONT_FAMILY)
                    .text_size(px(11.5))
                    .line_height(px(18.0))
                    .text_color(hsla(self.tokens.muted_foreground))
                    .child(detail_text.to_owned()),
            );
        }
        container.into_any_element()
    }

    /// Renders Conn's `TimelinePendingApprovalRow`: a `WorkLogRow` with monospace command/title,
    /// muted detail, warning `"Waiting for approval"` status, and inline Approve / Decline actions.
    fn render_approval_row(
        &self,
        id: &str,
        title: &str,
        detail: Option<&str>,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let mut meta = div()
            .ml(px(30.0))
            .flex()
            .flex_col()
            .gap(px(4.0))
            .pb(px(4.0))
            .text_size(px(12.0))
            .line_height(px(16.0));

        if let Some(detail_text) = detail.filter(|d| !d.trim().is_empty()) {
            meta = meta.child(
                div()
                    .text_color(hsla(self.tokens.muted_foreground))
                    .child(detail_text.to_owned()),
            );
        }

        let actions = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .gap_x(px(8.0))
            .gap_y(px(4.0))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(4.0))
                    .text_color(hsla(self.tokens.warning))
                    .child(icons::icon(icons::SHIELD, 12.0, hsla(self.tokens.warning)))
                    .child("Waiting for approval"),
            )
            .child(
                div()
                    .text_color(hsla(self.tokens.muted_foreground))
                    .child("·"),
            )
            .child(
                div()
                    .id(SharedString::from(format!("approve-{id}")))
                    .cursor_pointer()
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(hsla(self.tokens.foreground))
                    .hover(|s| s.underline())
                    .on_click({
                        let entry_id = id.to_owned();
                        cx.listener(move |_, _, _, cx| {
                            cx.emit(ChatEvent::Approval {
                                entry_id: entry_id.clone(),
                                decision: "accept".to_owned(),
                            });
                        })
                    })
                    .child("Approve"),
            )
            .child(
                div()
                    .id(SharedString::from(format!("deny-{id}")))
                    .cursor_pointer()
                    .text_color(hsla(self.tokens.muted_foreground))
                    .hover(|s| s.text_color(hsla(self.tokens.foreground)).underline())
                    .on_click({
                        let entry_id = id.to_owned();
                        cx.listener(move |_, _, _, cx| {
                            cx.emit(ChatEvent::Approval {
                                entry_id: entry_id.clone(),
                                decision: "decline".to_owned(),
                            });
                        })
                    })
                    .child("Decline"),
            );

        meta = meta.child(actions);

        div()
            .w_full()
            .min_w_0()
            .pb(px(8.0))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .w_full()
                    .min_w_0()
                    .px(px(2.0))
                    .py(px(2.0))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_start()
                            .gap(px(6.0))
                            .min_h(px(24.0))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .size(px(24.0))
                                    .flex_none()
                                    .child(icons::icon(
                                        icons::SHIELD_WARNING,
                                        16.0,
                                        muted_icon(&self.tokens),
                                    )),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .pt(px(2.0))
                                    .font_family(MONO_FONT_FAMILY)
                                    .text_size(px(12.0))
                                    .line_height(px(20.0))
                                    .text_color(hsla(self.tokens.foreground))
                                    .child(title.to_owned()),
                            ),
                    )
                    .child(meta),
            )
            .into_any_element()
    }

    fn render_notice_row(&self, text: &str, is_error: bool) -> AnyElement {
        if is_error {
            // Conn `WorkEntryLogRow` error: `WorkLogRow` with `CircleAlertIcon` + destructive `text-sm font-medium`.
            return div()
                .w_full()
                .min_w_0()
                .pb(px(8.0))
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_start()
                        .gap(px(6.0))
                        .min_h(px(24.0))
                        .px(px(2.0))
                        .py(px(2.0))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .justify_center()
                                .size(px(24.0))
                                .flex_none()
                                .child(icons::icon(
                                    icons::ERROR_CIRCLE,
                                    16.0,
                                    hsla(self.tokens.destructive),
                                )),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .text_size(px(BODY_FONT_PX))
                                .line_height(px(BODY_LINE_HEIGHT_PX))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(hsla(self.tokens.destructive))
                                .child(text.to_owned()),
                        ),
                )
                .into_any_element();
        }

        // Conn `TimelineSystemDivider`: centered pill between 1px `--shell-divider` hairlines.
        div()
            .w_full()
            .min_w_0()
            .pb(px(8.0))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.0))
                    .py(px(8.0))
                    .text_size(px(12.0))
                    .line_height(px(16.0))
                    .text_color(hsla(self.tokens.muted_foreground))
                    .child(
                        div()
                            .flex_1()
                            .h(px(1.0))
                            .bg(hsla(self.tokens.shell_divider)),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(6.0))
                            .px(px(8.0))
                            .py(px(4.0))
                            .child(icons::icon(
                                icons::INFO,
                                12.0,
                                hsla(self.tokens.muted_foreground),
                            ))
                            .child(text.to_owned()),
                    )
                    .child(
                        div()
                            .flex_1()
                            .h(px(1.0))
                            .bg(hsla(self.tokens.shell_divider)),
                    ),
            )
            .into_any_element()
    }

    /// Renders Conn's `WorkingTimelineRow`: `border-b border-(--shell-divider)! pb-2 pt-1`,
    /// `h-6 px-1 text-sm leading-relaxed text-muted-foreground`.
    fn render_working_row(&self) -> AnyElement {
        div()
            .w_full()
            .min_w_0()
            .pb(px(6.0))
            .child(
                div()
                    .w_full()
                    .pt(px(4.0))
                    .pb(px(8.0))
                    .border_b_1()
                    .border_color(hsla(self.tokens.shell_divider))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(8.0))
                            .h(px(24.0))
                            .px(px(4.0))
                            .text_size(px(BODY_FONT_PX))
                            .line_height(px(BODY_LINE_HEIGHT_PX))
                            .text_color(hsla(self.tokens.muted_foreground))
                            .child(TurningArc::new(14.0, hsla(self.tokens.muted_foreground)))
                            .child("Working..."),
                    ),
            )
            .into_any_element()
    }
}

impl Render for ChatView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        if !self.has_thread {
            return div()
                .flex()
                .flex_col()
                .size_full()
                .min_h_0()
                .min_w_0()
                .child(self.render_empty_no_thread());
        }

        // Conn `.chat-content-lane`: centered `max-w-(--chat-content-max-width)` (736px),
        // `TIMELINE_LIST_HEADER` (`h-4` = 16px) at top, `h-4` (16px) at bottom; each row owns its `pb-*`.
        let mut lane = div()
            .flex()
            .flex_col()
            .w_full()
            .max_w(px(CHAT_CONTENT_MAX_WIDTH_PX))
            .mx_auto()
            .pt(px(16.0))
            .pb(px(16.0));

        if self.cache.rows().is_empty() && !self.working {
            // Conn `MessagesTimeline` empty state: centered muted `text-sm` prompt.
            lane = lane.flex_1().items_center().justify_center().child(
                div()
                    .py(px(64.0))
                    .text_size(px(BODY_FONT_PX))
                    .line_height(px(BODY_LINE_HEIGHT_PX))
                    .text_color(hsla(self.tokens.muted_foreground))
                    .child("Send a message to start the conversation."),
            );
        } else {
            let items = group_rows(self.cache.rows());
            // When the active turn already has a trailing active work group, place Conn's
            // `"Working..."` divider above those live work rows; otherwise place it at the end.
            let working_before_idx = if self.working {
                items
                    .last()
                    .filter(|item| {
                        matches!(
                            item,
                            TimelineItem::WorkGroup {
                                has_active: true,
                                ..
                            }
                        )
                    })
                    .map(|_| items.len() - 1)
            } else {
                None
            };

            for (idx, item) in items.iter().enumerate() {
                if working_before_idx == Some(idx) {
                    lane = lane.child(self.render_working_row());
                }
                lane = lane.child(self.render_timeline_item(item, cx));
                if let Some(cp) = self.checkpoint_after_item(&items, idx) {
                    lane = lane.child(self.render_changed_files_card(idx, cp, cx));
                }
            }
            if self.working && working_before_idx.is_none() {
                lane = lane.child(self.render_working_row());
            }
        }

        let timeline = div()
            .id("chat-timeline-scroll")
            .flex_1()
            .min_h_0()
            .w_full()
            .overflow_y_scroll()
            .track_scroll(&self.scroll_handle)
            .px(px(CHAT_LANE_PADDING_X_PX))
            .child(lane);

        let composer_lane = div()
            .flex_none()
            .w_full()
            .px(px(CHAT_LANE_PADDING_X_PX))
            .pb(px(16.0))
            .pt(px(8.0))
            .child(
                div()
                    .w_full()
                    .max_w(px(CHAT_CONTENT_MAX_WIDTH_PX))
                    .mx_auto()
                    .child(self.composer.clone()),
            );

        div()
            .flex()
            .flex_col()
            .size_full()
            .min_h_0()
            .min_w_0()
            .child(timeline)
            .child(composer_lane)
    }
}

/// Formats Conn's settled work-group label (`Worked` / `Worked for 7.5s` / `Worked for 2m 14s`).
#[must_use]
fn format_worked_label(duration_ms: Option<u64>) -> String {
    let Some(ms) = duration_ms.filter(|&d| d >= 100) else {
        return "Worked".to_owned();
    };
    if ms < 10_000 {
        format!("Worked for {:.1}s", (ms as f64) / 1000.0)
    } else if ms < 60_000 {
        format!("Worked for {}s", (ms + 500) / 1000)
    } else {
        let total_secs = (ms + 500) / 1000;
        let mins = total_secs / 60;
        let secs = total_secs % 60;
        if secs == 0 {
            format!("Worked for {mins}m")
        } else {
            format!("Worked for {mins}m {secs}s")
        }
    }
}

#[cfg(test)]
mod worked_label_tests {
    use super::format_worked_label;

    #[test]
    fn formats_worked_duration_labels() {
        assert_eq!(format_worked_label(None), "Worked", "missing duration");
        assert_eq!(format_worked_label(Some(50)), "Worked", "sub-100ms");
        assert_eq!(
            format_worked_label(Some(7_500)),
            "Worked for 7.5s",
            "sub-10s shows one decimal"
        );
        assert_eq!(
            format_worked_label(Some(42_400)),
            "Worked for 42s",
            "10..60s rounds to whole seconds"
        );
        assert_eq!(
            format_worked_label(Some(134_000)),
            "Worked for 2m 14s",
            "minutes and seconds"
        );
    }
}
