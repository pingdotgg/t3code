//! Conn chat card view: messages timeline, collapsible thinking/tool rows,
//! working indicator, empty state, and bottom composer.

mod cache;
mod color;
mod composer;
mod icons;
mod markdown;
mod spinner;

use std::collections::HashSet;
use std::fmt;

use conn_state::{ItemStatus, ThreadState, TimelineEntry};
use conn_theme::{ShellGeometry, Tokens};
use gpui_kit::component::input::{InputEvent, TextareaState};
use gpui_kit::{
    AnyElement, AppContext as _, Context, Entity, EventEmitter, FontWeight, InteractiveElement,
    IntoElement, ParentElement, Render, ScrollHandle, SharedString, StatefulInteractiveElement,
    Styled, Subscription, Window, div, px,
};

use self::cache::{CachedRow, RowCache};
use self::color::{hsla, hsla_alpha};
use self::composer::{COMPOSER_MAX_LINES, COMPOSER_MIN_LINES, COMPOSER_PLACEHOLDER};
use self::spinner::TurningArc;

#[expect(
    unused_imports,
    reason = "re-exported for the orchestrator to register Phosphor assets"
)]
pub(crate) use self::icons::{PhosphorAssets, phosphor_assets};

/// Centered chat content lane width matching Conn's `--chat-content-max-width` (`46rem`).
const CHAT_CONTENT_MAX_WIDTH_PX: f32 = 736.0;
/// Horizontal lane padding matching `.chat-composer-lane` / `.messages-timeline-scroll` (`3rem`).
const CHAT_LANE_PADDING_X_PX: f32 = 48.0;
/// Distance from the bottom edge (in px) within which auto-follow stays engaged.
const STICK_TO_BOTTOM_THRESHOLD_PX: f32 = 24.0;
/// Standard panel chrome typography (`text-ui`: `13px` / `20px`).
const UI_FONT_PX: f32 = 13.0;
const UI_LINE_HEIGHT_PX: f32 = 20.0;
const MONO_FONT_FAMILY: &str = "JetBrains Mono";

/// Events emitted by [`ChatView`] to the host shell.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ChatEvent {
    Send(String),
    Stop,
}

/// GPUI entity rendering the Conn chat card (timeline + composer).
pub(crate) struct ChatView {
    tokens: Tokens,
    has_thread: bool,
    thread_id: Option<String>,
    thread_title: Option<String>,
    working: bool,
    cache: RowCache,
    expanded_ids: HashSet<String>,
    copied_code_key: Option<String>,
    model_label: String,
    /// Project root; tool row paths under it show relative, as in Conn.
    workspace_root: Option<String>,
    scroll_handle: ScrollHandle,
    stick_to_bottom: bool,
    textarea: Entity<TextareaState>,
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
    pub(crate) fn new(tokens: Tokens, window: &mut Window, cx: &mut Context<'_, Self>) -> Self {
        let textarea = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder(COMPOSER_PLACEHOLDER)
                .auto_grow(COMPOSER_MIN_LINES, COMPOSER_MAX_LINES)
                .submit_on_enter(true)
        });
        let input_sub = cx.subscribe_in(
            &textarea,
            window,
            |this, _, event: &InputEvent, window, cx| match event {
                InputEvent::PressEnter { shift: false, .. } => {
                    this.submit_composer(window, cx);
                }
                InputEvent::Change => {
                    cx.notify();
                }
                _ => {}
            },
        );

        Self {
            tokens,
            has_thread: false,
            thread_id: None,
            thread_title: None,
            working: false,
            cache: RowCache::default(),
            expanded_ids: HashSet::new(),
            copied_code_key: None,
            model_label: "Default model".to_owned(),
            workspace_root: None,
            scroll_handle: ScrollHandle::new(),
            stick_to_bottom: true,
            textarea,
            _input_sub: input_sub,
        }
    }

    /// Replaces the active theme tokens and triggers a repaint.
    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        if self.tokens == tokens {
            return;
        }
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
            self.expanded_ids.clear();
            self.copied_code_key = None;
            self.stick_to_bottom = true;
            cx.notify();
            return;
        };

        let switched_thread = self.thread_id.as_deref() != Some(thread.thread_id.as_str());
        if switched_thread {
            self.thread_id = Some(thread.thread_id.clone());
            self.expanded_ids.clear();
            self.copied_code_key = None;
            self.stick_to_bottom = true;
        }

        self.has_thread = true;
        self.working = thread.working;
        let _stats = self.cache.sync(&thread.entries);

        if self.stick_to_bottom {
            self.scroll_handle.scroll_to_bottom();
        }
        cx.notify();
    }

    /// Sets the model display label shown in the composer footer.
    /// Sets the project root used to shorten tool row paths.
    pub(crate) fn set_workspace_root(&mut self, root: Option<String>, cx: &mut Context<'_, Self>) {
        if self.workspace_root != root {
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
        self.model_label = label;
        cx.notify();
    }

    pub(super) fn submit_composer(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let raw = self.textarea.read(cx).value().to_string();
        let trimmed = raw.trim().to_owned();
        if trimmed.is_empty() {
            return;
        }
        self.textarea.update(cx, |input, cx| {
            input.set_value("", window, cx);
        });
        self.stick_to_bottom = true;
        cx.emit(ChatEvent::Send(trimmed));
        cx.notify();
    }

    pub(super) fn emit_stop(&mut self, cx: &mut Context<'_, Self>) {
        cx.emit(ChatEvent::Stop);
    }

    pub(super) fn mark_code_copied(&mut self, key: String, cx: &mut Context<'_, Self>) {
        self.copied_code_key = Some(key);
        cx.notify();
    }

    fn toggle_expanded(&mut self, id: &str, cx: &mut Context<'_, Self>) {
        if !self.expanded_ids.remove(id) {
            self.expanded_ids.insert(id.to_owned());
        }
        cx.notify();
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

    fn render_row(&self, row: &CachedRow, cx: &mut Context<'_, Self>) -> AnyElement {
        match &row.entry {
            TimelineEntry::User { text, .. } => self.render_user_bubble(text),
            TimelineEntry::Assistant { id, .. } => {
                let blocks = row.blocks.as_deref().unwrap_or(&[]);
                markdown::render_blocks(
                    id,
                    blocks,
                    &self.tokens,
                    self.copied_code_key.as_deref(),
                    cx,
                )
            }
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
            TimelineEntry::Approval { id, title, detail } => {
                self.render_approval_card(id, title, detail.as_deref())
            }
            TimelineEntry::Notice { text, is_error, .. } => self.render_notice_row(text, *is_error),
        }
    }

    fn render_user_bubble(&self, text: &str) -> AnyElement {
        let radius = ShellGeometry::default().bubble_radius_px;
        div()
            .flex()
            .flex_row()
            .justify_end()
            .w_full()
            .child(
                div()
                    .max_w(px(CHAT_CONTENT_MAX_WIDTH_PX * 0.8))
                    .rounded(px(radius))
                    .bg(hsla(self.tokens.message_surface))
                    .px(px(16.0))
                    .pt(px(10.0))
                    .pb(px(12.0))
                    .text_size(px(14.0))
                    .line_height(px(22.0))
                    .text_color(hsla(self.tokens.message_foreground))
                    .child(text.to_owned()),
            )
            .into_any_element()
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
        let has_body = !text.trim().is_empty();
        let label = if streaming { "Thinking..." } else { "Thought" };

        let mut header = div()
            .id(SharedString::from(format!("thinking-{id}")))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .py(px(4.0))
            .px(px(6.0))
            .rounded(px(8.0))
            .cursor_pointer()
            .text_size(px(UI_FONT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .text_color(hsla(self.tokens.muted_foreground))
            .hover(|s| s.bg(hsla(self.tokens.shell_highlight)))
            .on_click(cx.listener(move |view, _, _, cx| {
                view.toggle_expanded(&toggle_id, cx);
            }))
            .child(icons::icon(
                icons::BRAIN,
                14.0,
                hsla(self.tokens.muted_foreground),
            ))
            .child(label);

        if streaming {
            header = header.child(TurningArc::new(13.0, hsla(self.tokens.muted_foreground)));
        }
        if has_body {
            header = header.child(icons::icon(
                if expanded {
                    icons::CARET_DOWN
                } else {
                    icons::CARET_RIGHT
                },
                12.0,
                hsla(self.tokens.muted_foreground),
            ));
        }

        let mut container = div().flex().flex_col().gap(px(4.0)).w_full().child(header);
        if expanded && has_body {
            container = container.child(
                div()
                    .ml(px(22.0))
                    .pl(px(10.0))
                    .py(px(4.0))
                    .border_l_2()
                    .border_color(hsla(self.tokens.shell_divider))
                    .text_size(px(UI_FONT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(hsla(self.tokens.muted_foreground))
                    .child(text.to_owned()),
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
            ItemStatus::Running => (
                hsla(self.tokens.muted_foreground),
                hsla(self.tokens.foreground),
            ),
            ItemStatus::Completed => (
                hsla(self.tokens.muted_foreground),
                hsla(self.tokens.muted_foreground),
            ),
        };

        let leading: AnyElement = match status {
            ItemStatus::Running => {
                TurningArc::new(14.0, hsla(self.tokens.muted_foreground)).into_any_element()
            }
            ItemStatus::Failed => icons::icon(icons::WARNING, 14.0, icon_color).into_any_element(),
            ItemStatus::Completed => {
                icons::icon(icons::tool_icon_path(kind), 14.0, icon_color).into_any_element()
            }
        };

        let mut header = div()
            .id(SharedString::from(format!("tool-{id}")))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .w_full()
            .min_w_0()
            .py(px(4.0))
            .px(px(6.0))
            .rounded(px(8.0))
            .cursor_pointer()
            .text_size(px(UI_FONT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .hover(|s| s.bg(hsla(self.tokens.shell_highlight)))
            .on_click(cx.listener(move |view, _, _, cx| {
                view.toggle_expanded(&toggle_id, cx);
            }))
            .child(leading)
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
            header = header.child(icons::icon(
                if expanded {
                    icons::CARET_DOWN
                } else {
                    icons::CARET_RIGHT
                },
                12.0,
                hsla(self.tokens.muted_foreground),
            ));
        }

        let mut container = div()
            .flex()
            .flex_col()
            .gap(px(4.0))
            .w_full()
            .min_w_0()
            .child(header);
        if expanded && let Some(detail_text) = detail.filter(|d| !d.trim().is_empty()) {
            container = container.child(
                div()
                    .ml(px(22.0))
                    .px(px(12.0))
                    .py(px(8.0))
                    .rounded(px(10.0))
                    .bg(hsla(self.tokens.code_background))
                    .border_1()
                    .border_color(hsla(self.tokens.shell_divider))
                    .font_family(MONO_FONT_FAMILY)
                    .text_size(px(12.0))
                    .line_height(px(18.0))
                    .text_color(hsla(self.tokens.code_foreground))
                    .child(detail_text.to_owned()),
            );
        }
        container.into_any_element()
    }

    fn render_approval_card(&self, id: &str, title: &str, detail: Option<&str>) -> AnyElement {
        let mut body = div()
            .flex()
            .flex_col()
            .gap(px(4.0))
            .flex_1()
            .min_w_0()
            .child(
                div()
                    .text_size(px(UI_FONT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(hsla(self.tokens.foreground))
                    .child(title.to_owned()),
            );
        if let Some(detail_text) = detail.filter(|d| !d.trim().is_empty()) {
            body = body.child(
                div()
                    .text_size(px(UI_FONT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(hsla(self.tokens.muted_foreground))
                    .child(detail_text.to_owned()),
            );
        }

        let actions = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .pt(px(8.0))
            .child(
                div()
                    .id(SharedString::from(format!("approve-{id}")))
                    .px(px(12.0))
                    .py(px(5.0))
                    .rounded(px(8.0))
                    .bg(hsla(self.tokens.primary))
                    .text_size(px(UI_FONT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(hsla(self.tokens.primary_foreground))
                    .child("Approve"),
            )
            .child(
                div()
                    .id(SharedString::from(format!("deny-{id}")))
                    .px(px(12.0))
                    .py(px(5.0))
                    .rounded(px(8.0))
                    .bg(hsla(self.tokens.shell_control))
                    .border_1()
                    .border_color(hsla(self.tokens.shell_divider_header))
                    .text_size(px(UI_FONT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(hsla(self.tokens.foreground))
                    .child("Deny"),
            );

        div()
            .w_full()
            .rounded(px(12.0))
            .bg(hsla(self.tokens.shell_raised))
            .border_1()
            .border_color(hsla(self.tokens.shell_divider_header))
            .p(px(12.0))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_start()
                    .gap(px(10.0))
                    .child(div().pt(px(2.0)).child(icons::icon(
                        icons::SHIELD_WARNING,
                        16.0,
                        hsla(self.tokens.warning),
                    )))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .child(body)
                            .child(actions),
                    ),
            )
            .into_any_element()
    }

    fn render_notice_row(&self, text: &str, is_error: bool) -> AnyElement {
        let (bg, fg, icon_path) = if is_error {
            (
                hsla_alpha(self.tokens.destructive, 0.10),
                hsla(self.tokens.destructive),
                icons::WARNING,
            )
        } else {
            (
                hsla_alpha(self.tokens.info, 0.10),
                hsla(self.tokens.info_foreground),
                icons::INFO,
            )
        };
        div()
            .w_full()
            .px(px(4.0))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.0))
                    .px(px(12.0))
                    .py(px(8.0))
                    .rounded(px(10.0))
                    .bg(bg)
                    .text_size(px(UI_FONT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(fg)
                    .child(icons::icon(icon_path, 15.0, fg))
                    .child(div().flex_1().min_w_0().child(text.to_owned())),
            )
            .into_any_element()
    }

    fn render_working_row(&self) -> AnyElement {
        div()
            .w_full()
            .pt(px(4.0))
            .pb(px(8.0))
            .border_b_1()
            .border_color(hsla(self.tokens.shell_divider_header))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.0))
                    .px(px(4.0))
                    .text_size(px(UI_FONT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(hsla(self.tokens.muted_foreground))
                    .child(TurningArc::new(14.0, hsla(self.tokens.muted_foreground)))
                    .child("Working..."),
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

        let has_text = !self.textarea.read(cx).value().trim().is_empty();

        let mut lane = div()
            .flex()
            .flex_col()
            .gap(px(14.0))
            .w_full()
            .max_w(px(CHAT_CONTENT_MAX_WIDTH_PX))
            .mx_auto()
            .pt(px(20.0))
            .pb(px(24.0));

        if self.cache.rows().is_empty() && !self.working {
            let empty_title = self
                .thread_title
                .as_deref()
                .filter(|t| !t.trim().is_empty())
                .unwrap_or("New thread");
            lane = lane.child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .gap(px(6.0))
                    .py(px(64.0))
                    .child(
                        div()
                            .text_size(px(15.0))
                            .line_height(px(22.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(hsla(self.tokens.foreground))
                            .child(empty_title.to_owned()),
                    )
                    .child(
                        div()
                            .text_size(px(UI_FONT_PX))
                            .line_height(px(UI_LINE_HEIGHT_PX))
                            .text_color(hsla(self.tokens.muted_foreground))
                            .child("Send a message below to start the conversation."),
                    ),
            );
        } else {
            for row in self.cache.rows() {
                lane = lane.child(self.render_row(row, cx));
            }
            if self.working {
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
                    .child(composer::render_composer(
                        &self.textarea,
                        &self.model_label,
                        has_text,
                        self.working,
                        &self.tokens,
                        cx,
                    )),
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
