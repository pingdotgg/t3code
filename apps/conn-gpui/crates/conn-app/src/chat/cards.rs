//! Interactive timeline cards and message chrome ported 1:1 from Conn:
//!
//! - `ComposerPendingUserInputPanel.tsx`: question picker (rendered inline in the timeline,
//!   since the composer is owned by another surface), plus answered-question history.
//! - `SecretRequestCard.tsx`: masked secret form and its settled `WorkLogRow`.
//! - `ProposedPlanCard.tsx`: plan badge, title, copy action, collapse with fade.
//! - `V2LifecycleRow.tsx` `SubagentTimelineLink`: clickable subagent row.
//! - `ChangedFilesTree.tsx` `ChangedFilesCard`: sticky header + collapsible directory tree.
//! - `TimelineUserMessageRow.tsx` / `TimelineAssistantRows.tsx`: hover action bars with
//!   day-aware timestamps (`timestampFormat.ts`), Copy, and Fork.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use conn_state::{
    LocalDateTime, PLAN_PREVIEW_MAX_LINES, SecretRequestStatus, TimelineEntry,
    TurnCheckpointSummary, TurnItemStatus, UserInputAnswer, UserInputDraft, UserInputQuestion,
    build_turn_diff_tree, build_user_input_answers, collapsed_plan_preview, flatten_turn_diff_tree,
    format_chat_timestamp_tooltip, format_day_aware_timestamp, normalize_plan_markdown_for_export,
    plan_can_collapse, strip_displayed_plan_markdown, subagent_status_visual,
};
use conn_theme::Appearance;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, AppContext as _, ClipboardItem, Context, Entity, FontWeight, Hsla,
    InteractiveElement, IntoElement, MouseButton, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, Subscription, Task, Window, div, linear_color_stop,
    linear_gradient, px,
};

use super::card_face::{
    CARD_ACTION_BOX_PX, CARD_ACTION_ICON_PX, CARD_BODY_RADIUS_PX, CARD_CHEVRON_ROOM_PX,
    CARD_ICON_PX, CARD_LINE_PX, CARD_META_LINE_PX, CARD_PREVIEW_LINES, CARD_TEXT_PX, CHECKLIST,
    CardFace, DOWNLOAD, card_body, card_colors, card_header, card_hover_surface, card_shell,
    disclosure_chevron, icon_with_dot, one_line_preview,
};
use super::color::{hsla, hsla_alpha, muted_icon, prose_foreground};
use super::composer_state::{ComposerPendingRequest, PendingQuestion};
use super::{
    BODY_FONT_PX, BODY_LINE_HEIGHT_PX, ChatEvent, ChatView, MONO_FONT_FAMILY, UI_FONT_PX,
    UI_LINE_HEIGHT_PX, icons, markdown,
};
use crate::a11y::ConnA11yExt as _;
use crate::panels::chrome::ConnTooltipExt as _;

fn attachment_name(att: &conn_contract::ChatAttachment) -> &str {
    match att {
        conn_contract::ChatAttachment::Image(image) => &image.name,
        conn_contract::ChatAttachment::File(file) => &file.name,
        conn_contract::ChatAttachment::Unknown(unknown) => &unknown.name,
    }
}

/// The `expanded_ids` key of a subagent card's summary.
pub(super) fn subagent_summary_key(entry_id: &str) -> String {
    format!("subagent-summary-{entry_id}")
}

/// Conn's single-select auto-advance delay after picking an option.
const AUTO_ADVANCE_DELAY: Duration = Duration::from_millis(200);
/// Conn's `ANCHORED_COPY_TOAST_TIMEOUT_MS`: how long a Copy button shows its check.
const COPY_CONFIRM_DURATION: Duration = Duration::from_millis(1_000);
/// Conn's `SECRET_REQUEST_DEFAULT_PLACEHOLDER`.
const SECRET_DEFAULT_PLACEHOLDER: &str = "Paste the secret";
/// Conn's changed-files row indent per depth (`4 + depth * 14`).
const TREE_INDENT_PX: f32 = 14.0;

/// Local state of one pending question card.
pub(super) struct UserInputCardState {
    pub(super) question_index: usize,
    pub(super) drafts: HashMap<String, UserInputDraft>,
    pub(super) responding: bool,
    pub(super) error: Option<String>,
    /// The agent's lead-in shows in full (`Show more`) instead of three lines.
    pub(super) context_expanded: bool,
    pub(super) _auto_advance: Option<Task<()>>,
}

impl UserInputCardState {
    fn new() -> Self {
        Self {
            question_index: 0,
            drafts: HashMap::new(),
            responding: false,
            error: None,
            context_expanded: false,
            _auto_advance: None,
        }
    }
}

/// Local state of one pending secret form.
pub(super) struct SecretFormState {
    input: Entity<InputState>,
    pub(super) submitting: bool,
    pub(super) error: Option<String>,
    _subscription: Subscription,
}

/// Lazily fetched detail of a tool row whose output the snapshot omitted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum DetailFetch {
    Loading,
    Loaded(Option<String>),
    Failed(String),
}

/// Returns local wall-clock time for Unix ms (falls back to UTC).
fn local_datetime(epoch_ms: i64) -> LocalDateTime {
    #[cfg(unix)]
    {
        let raw_time = epoch_ms.div_euclid(1_000) as libc::time_t;
        let mut local_tm = std::mem::MaybeUninit::<libc::tm>::zeroed();
        // SAFETY: `raw_time` is a valid `time_t` by value and `local_tm` is valid writable
        // stack storage; `localtime_r` is thread-safe and returns null on failure.
        let ptr = unsafe { libc::localtime_r(&raw_time, local_tm.as_mut_ptr()) };
        if !ptr.is_null() {
            // SAFETY: `localtime_r` succeeded and initialized `local_tm`.
            let tm = unsafe { local_tm.assume_init() };
            return LocalDateTime::from_epoch_ms(epoch_ms, tm.tm_gmtoff);
        }
    }
    LocalDateTime::from_epoch_ms(epoch_ms, 0)
}

/// Day-aware label and full tooltip for an ISO timestamp (`formatDayAwareTimestamp` +
/// `formatChatTimestampTooltip`).
pub(super) fn timestamp_labels(iso: &str) -> Option<(String, String)> {
    let at = local_datetime(conn_state::parse_iso8601_epoch_ms(iso)?);
    let now = local_datetime(super::now_epoch_ms());
    Some((
        format_day_aware_timestamp(at, now),
        format_chat_timestamp_tooltip(at),
    ))
}

impl ChatView {
    // -----------------------------------------------------------------------------------------
    // Shared chrome
    // -----------------------------------------------------------------------------------------

    /// Copies `text` and shows the check on the button keyed `key` for one second.
    pub(super) fn copy_with_confirmation(
        &mut self,
        key: String,
        text: String,
        cx: &mut Context<'_, Self>,
    ) {
        cx.write_to_clipboard(ClipboardItem::new_string(text));
        self.copied_message_key = Some(key.clone());
        self._copy_reset = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(COPY_CONFIRM_DURATION).await;
            let _ = this.update(cx, |view, cx| {
                if view.copied_message_key.as_deref() == Some(key.as_str()) {
                    view.copied_message_key = None;
                    cx.notify();
                }
            });
        }));
        cx.notify();
    }

    /// Conn `MessageCopyButton` (`size="xs" variant="ghost"`): copy icon, check while copied.
    pub(super) fn render_copy_button(
        &self,
        key: &str,
        label: &'static str,
        text: String,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        self.render_copy_action(key, label, move || text.clone(), cx)
    }

    fn render_copy_action(
        &self,
        key: &str,
        label: &'static str,
        copy_text: impl Fn() -> String + 'static,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let copied = self.copied_message_key.as_deref() == Some(key);
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground);
        let hover_bg = hsla_alpha(self.tokens.foreground, 0.06);
        let icon_color = if copied {
            hsla(self.tokens.primary)
        } else {
            muted
        };
        let key_owned = key.to_owned();
        let button = div()
            .id(SharedString::from(format!("copy-{key}")))
            .a11y_button(SharedString::from(format!("chat.copy.{key}")), label)
            .flex()
            .items_center()
            .justify_center()
            .size(px(CARD_ACTION_BOX_PX))
            .rounded(px(6.0))
            .cursor_pointer()
            .hover(move |s| s.bg(hover_bg).text_color(fg))
            .on_click(cx.listener(move |view, _, _, cx| {
                view.copy_with_confirmation(key_owned.clone(), copy_text(), cx);
            }))
            .conn_tooltip(if copied { "Copied" } else { label }, &self.tokens)
            .child(icons::icon(
                if copied { icons::CHECK } else { icons::COPY },
                CARD_ACTION_ICON_PX,
                icon_color,
            ));
        #[cfg(test)]
        let button = gpui_kit::TestSupportExt::test_support(button);
        button.into_any_element()
    }

    /// The hover timestamp, 13px muted like the card text, with the full time as its tooltip.
    pub(super) fn render_timestamp(&self, key: &str, iso: Option<&str>) -> Option<AnyElement> {
        let (label, tooltip) = timestamp_labels(iso?)?;
        Some(
            div()
                .id(SharedString::from(format!("ts-{key}")))
                .a11y(
                    gpui_kit::Role::Label,
                    format!("chat.timestamp.{key}"),
                    format!("Sent {tooltip}"),
                )
                .flex_none()
                .whitespace_nowrap()
                .text_size(px(CARD_TEXT_PX))
                .line_height(px(CARD_META_LINE_PX))
                .text_color(hsla(self.tokens.muted_foreground))
                .conn_tooltip(tooltip, &self.tokens)
                .child(label)
                .into_any_element(),
        )
    }

    /// The thumbnail of a sent attachment at `target` px, once it is decoded. The first call
    /// queues its download and decode; the chat repaints when it ends.
    fn attachment_image(
        &self,
        image: &conn_contract::ChatImageAttachment,
        target: super::thumb_cache::TargetPx,
        cx: &mut Context<'_, Self>,
    ) -> Option<(gpui_kit::ImageSource, Option<f32>)> {
        use super::attachment_thumb::{SentImage, ThumbJob};
        self.connection.as_ref()?;
        let key = (image.id.clone(), target);
        let mut thumbs = self.attachment_thumbs.borrow_mut();
        if let Some(entry) = thumbs.get(&key) {
            if matches!(entry, SentImage::Loading(_)) {
                self.thumb_loads.borrow_mut().touch(&key);
            }
            return entry.source();
        }
        let request = self.next_thumb_request.get();
        self.next_thumb_request.set(request + 1);
        for old in thumbs.insert(key.clone(), SentImage::Loading(request), 0) {
            old.release(cx);
        }
        drop(thumbs);
        let job = ThumbJob {
            attachment_id: image.id.clone(),
            mime_type: image.mime_type.clone(),
        };
        let start = self.thumb_loads.borrow_mut().request(request, key, job);
        if let Some(start) = start {
            self.start_thumb(start, cx);
        }
        None
    }

    /// Downloads and decodes one thumbnail; its permit in [`Self::thumb_loads`] is taken. The
    /// task is never dropped: a cancel only sets its flag, so the permit stays held until the
    /// download and decode have really returned.
    pub(super) fn start_thumb(
        &self,
        (request, key, job): (u64, super::ThumbKey, super::attachment_thumb::ThumbJob),
        cx: &mut Context<'_, Self>,
    ) {
        use super::attachment_thumb::{SentImage, load_sent_image};
        let cancel = Arc::new(AtomicBool::new(false));
        self.thumb_cancels
            .borrow_mut()
            .insert(request, cancel.clone());
        let connection = self.connection.clone();
        let svg_renderer = cx.svg_renderer();
        let target = key.1;
        cx.spawn(async move |this, cx| {
            let bytes = match connection {
                Some(connection) if !cancel.load(Ordering::Relaxed) => connection
                    .fetch_attachment_bytes_within(
                        &job.attachment_id,
                        super::thumb_cache::LOAD_DEADLINES,
                    )
                    .await
                    .ok(),
                _ => None,
            };
            let loaded = match bytes {
                Some(bytes) if !cancel.load(Ordering::Relaxed) => {
                    cx.background_executor()
                        .spawn(async move {
                            load_sent_image(&job.mime_type, bytes, target, svg_renderer, &cancel)
                        })
                        .await
                }
                _ => (SentImage::Failed, 0),
            };
            let _ = this.update(cx, |view, cx| view.finish_thumb(request, key, loaded, cx));
        })
        .detach();
    }

    /// The work of load `request` returned: frees its permit, starts the next waiting load,
    /// and stores the result unless a cancel, newer load or reconnect replaced it.
    fn finish_thumb(
        &mut self,
        request: u64,
        key: super::ThumbKey,
        (image, cost): (super::attachment_thumb::SentImage, usize),
        cx: &mut Context<'_, Self>,
    ) {
        use super::attachment_thumb::SentImage;
        self.thumb_cancels.get_mut().remove(&request);
        for start in self.thumb_loads.get_mut().exited(request) {
            self.start_thumb(start, cx);
        }
        let current = matches!(
            self.attachment_thumbs.get_mut().peek(&key),
            Some(SentImage::Loading(waiting)) if *waiting == request
        );
        if current {
            for old in self.attachment_thumbs.get_mut().insert(key, image, cost) {
                old.release(cx);
            }
            cx.notify();
        } else {
            image.release(cx);
        }
    }

    /// Starts a thumbnail frame (the cache trims what is no longer drawn) and cancels loads of
    /// tiles not drawn since the last call. Runs once per chat render, before the timeline
    /// lays out its rows.
    pub(super) fn sweep_thumb_loads(&mut self, cx: &mut Context<'_, Self>) {
        for old in self.attachment_thumbs.get_mut().begin_frame() {
            old.release(cx);
        }
        for (request, key) in self.thumb_loads.get_mut().sweep() {
            if let Some(cancel) = self.thumb_cancels.get_mut().remove(&request) {
                cancel.store(true, Ordering::Relaxed);
            }
            let stale = matches!(
                self.attachment_thumbs.get_mut().peek(&key),
                Some(super::attachment_thumb::SentImage::Loading(waiting)) if *waiting == request
            );
            if stale && let Some(entry) = self.attachment_thumbs.get_mut().remove(&key) {
                entry.release(cx);
            }
        }
    }

    /// Cancels every thumbnail load and drops every thumbnail (reconnect). Running work keeps
    /// its permit until it returns.
    pub(super) fn clear_thumbs(&mut self, cx: &mut Context<'_, Self>) {
        let _running = self.thumb_loads.get_mut().clear();
        for (_, cancel) in self.thumb_cancels.get_mut().drain() {
            cancel.store(true, Ordering::Relaxed);
        }
        for image in self.attachment_thumbs.get_mut().clear() {
            image.release(cx);
        }
    }

    /// Attachment chips/thumbnails shown in queued bubbles (a sent bubble uses
    /// [`Self::render_sent_attachments`]). Images are `4:3`
    /// cells with `object-cover`, `rounded-lg` and a `border-border/80` edge, `20rem` wide for one image
    /// and two columns for several (`TimelineUserMessageRow.tsx`).
    pub(super) fn render_attachment_chips(
        &self,
        key: &str,
        attachments: &[conn_contract::ChatAttachment],
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let image_count = attachments
            .iter()
            .filter(|att| matches!(att, conn_contract::ChatAttachment::Image(_)))
            .count();
        let (image_w, image_h) = if image_count == 1 {
            (320.0, 240.0)
        } else {
            (156.0, 117.0)
        };
        let mut row = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .gap(px(8.0));
        for (idx, att) in attachments.iter().enumerate() {
            let chip_id = (SharedString::from(format!("att-{key}")), idx);
            let chip = match att {
                conn_contract::ChatAttachment::Image(img) => {
                    use super::attachment_thumb::{ThumbFit, chip_target, thumbnail};
                    let target =
                        chip_target(image_count == 1, (image_w, image_h), self.thumb_scale);
                    let (loaded, aspect) = match self.attachment_image(img, target, cx) {
                        Some((image, aspect)) => (Some(image), aspect),
                        None => (None, None),
                    };
                    let cell = div()
                        .id(chip_id)
                        .overflow_hidden()
                        .rounded(px(8.0))
                        .border_1()
                        .border_color(hsla_alpha(self.tokens.border, 0.80))
                        .conn_tooltip(img.name.clone(), &self.tokens);
                    // One image takes the bubble's full width at its own aspect ratio (Nick,
                    // #343); several keep web's two-column 4:3 cells. The picture inside the
                    // 1px border paints a 7px radius (#342).
                    if image_count == 1 {
                        cell.w_full().child(thumbnail(
                            loaded,
                            &self.tokens,
                            7.0,
                            ThumbFit::FullWidth(aspect),
                        ))
                    } else {
                        cell.flex_none()
                            .w(px(image_w))
                            .max_w_full()
                            .h(px(image_h))
                            .child(thumbnail(loaded, &self.tokens, 7.0, ThumbFit::Cover))
                    }
                }
                other => self.file_attachment_pill(chip_id, other),
            };
            row = row.child(chip.a11y_group(
                format!("chat.attachment.{key}.{idx}"),
                format!("Attachment {}", attachment_name(att)),
            ));
        }
        row.into_any_element()
    }

    /// The pill of a non-image attachment: file icon and name, or the name alone.
    fn file_attachment_pill(
        &self,
        id: (SharedString, usize),
        att: &conn_contract::ChatAttachment,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        match att {
            conn_contract::ChatAttachment::File(file) => {
                let file_icon = crate::file_icons::file_icon(&file.name);
                let icon_color = file_icon
                    .color
                    .map(|c| hsla(c.for_appearance(self.tokens.appearance)))
                    .unwrap_or_else(|| hsla(self.tokens.muted_foreground));
                self.attachment_pill(id, file.name.clone())
                    .child(icons::icon(file_icon.asset, 12.0, icon_color))
                    .child(div().min_w_0().truncate().child(file.name.clone()))
            }
            conn_contract::ChatAttachment::Unknown(unknown) => self
                .attachment_pill(id, unknown.name.clone())
                .child(div().min_w_0().truncate().child(unknown.name.clone())),
            conn_contract::ChatAttachment::Image(image) => {
                self.attachment_pill(id, image.name.clone())
            }
        }
    }

    /// The attachments of a sent user bubble, in their own order: each run of images is one
    /// gallery, each run of videos one stack of players, each run of files one stack of rows. The
    /// bubble's own 3px padding frames all three, so none carries an inset.
    pub(super) fn render_sent_attachments(
        &self,
        key: &str,
        attachments: &[conn_contract::ChatAttachment],
        cx: &mut Context<'_, Self>,
    ) -> Vec<AnyElement> {
        use super::attachment_thumb::{AttachmentKind, attachment_kind, gallery_columns, runs_by};
        // One column count for the whole message, so every run's tiles are the same size.
        let columns = gallery_columns(
            attachments
                .iter()
                .filter(|att| attachment_kind(att) == AttachmentKind::Image)
                .count(),
        );
        runs_by(attachments, attachment_kind)
            .into_iter()
            .map(|(kind, range)| {
                let start = range.start;
                let run = &attachments[range];
                match kind {
                    AttachmentKind::Image => {
                        self.render_image_gallery(key, start, run, columns, cx)
                    }
                    AttachmentKind::Video => self.render_video_run(key, start, run),
                    AttachmentKind::File => self.render_file_rows(key, start, run, cx),
                }
            })
            .collect()
    }

    /// One run of images as rows of `columns` equal 4:3 cover tiles, 3px apart. The bubble's
    /// padding is the gallery's inset. `columns` comes from the whole message, so a run with
    /// fewer images than columns (or a partial last row) keeps the same tile size and stays left
    /// aligned: the short row is filled out with empty cells of the same share. Tiles carry no
    /// border; the bubble is the frame.
    ///
    /// Rows are flex rows, not a grid: a grid sizes its row tracks while the bubble's own width
    /// is still being fitted to its caption, so it reserved tile heights for the cap width and
    /// left a blank band under tiles that then painted narrower. A flex cell gets its width first
    /// and its 4:3 height from that width.
    fn render_image_gallery(
        &self,
        key: &str,
        start: usize,
        run: &[conn_contract::ChatAttachment],
        columns: usize,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        use super::attachment_thumb::{
            GALLERY_INSET_PX, gallery_cell, gallery_tile, gallery_tile_target, tile_radii,
        };
        let target = gallery_tile_target(columns, self.thumb_scale);
        let mut gallery = div().flex().flex_col().gap(px(GALLERY_INSET_PX)).min_w_0();
        for (row_index, chunk) in run.chunks(columns).enumerate() {
            let mut row = div()
                .flex()
                .flex_row()
                .items_start()
                .gap(px(GALLERY_INSET_PX))
                .min_w_0();
            for (column, att) in chunk.iter().enumerate() {
                let conn_contract::ChatAttachment::Image(image) = att else {
                    continue;
                };
                let offset = row_index * columns + column;
                let idx = start + offset;
                let loaded = self
                    .attachment_image(image, target, cx)
                    .map(|(image, _)| image);
                let radii = tile_radii(offset, run.len(), columns);
                let cell = gallery_cell((SharedString::from(format!("att-{key}")), idx))
                    .flex_1()
                    .conn_tooltip(image.name.clone(), &self.tokens)
                    .child(gallery_tile(loaded, &self.tokens, radii));
                let cell = cell.a11y_group(
                    format!("chat.attachment.{key}.{idx}"),
                    format!("Attachment {}", image.name),
                );
                #[cfg(test)]
                let cell = gpui_kit::TestSupportExt::test_support(cell);
                row = row.child(cell);
            }
            for _ in chunk.len()..columns {
                row = row.child(div().flex_1().min_w_0());
            }
            gallery = gallery.child(row);
        }
        gallery.into_any_element()
    }

    /// One run of videos as a stack of full-width players, 3px apart, joined like file rows. The
    /// player (`render_sent_video`, in the embed worker) fills the slot in its own 4:3 box. A video
    /// the server cannot serve gets the same 4:3 tile saying so, never a player.
    fn render_video_run(
        &self,
        key: &str,
        start: usize,
        run: &[conn_contract::ChatAttachment],
    ) -> AnyElement {
        use super::attachment_thumb::{
            GALLERY_INSET_PX, attachment_downloadable, file_row_radii, video_mime_type,
        };
        let mut stack = div().flex().flex_col().gap(px(GALLERY_INSET_PX)).min_w_0();
        for (offset, att) in run.iter().enumerate() {
            let idx = start + offset;
            let (id, name, mime_type) = match att {
                conn_contract::ChatAttachment::File(file) => {
                    (&file.id, &file.name, &file.mime_type)
                }
                conn_contract::ChatAttachment::Unknown(unknown) => {
                    (&unknown.id, &unknown.name, &unknown.mime_type)
                }
                conn_contract::ChatAttachment::Image(image) => {
                    (&image.id, &image.name, &image.mime_type)
                }
            };
            let radii = file_row_radii(offset, run.len());
            let slot = div()
                .id((SharedString::from(format!("att-{key}")), idx))
                .a11y_group(
                    format!("chat.attachment.{key}.{idx}"),
                    format!("Attachment {name}"),
                )
                .w_full()
                .min_w_0()
                .overflow_hidden()
                .rounded_tl(px(radii.top_left))
                .rounded_tr(px(radii.top_right))
                .rounded_br(px(radii.bottom_right))
                .rounded_bl(px(radii.bottom_left));
            // The player gets the type the shared rules resolved, so a generic `.mp4` plays as
            // `video/mp4`.
            let video_type = video_mime_type(name, mime_type).unwrap_or_else(|| mime_type.clone());
            stack = stack.child(if attachment_downloadable(id) {
                slot.child(self.render_sent_video(key, idx, id, name, &video_type))
            } else {
                slot.child(self.render_unavailable_video(name))
            });
        }
        stack.into_any_element()
    }

    /// The 4:3 black tile of a video that cannot play: its name, and why there is no player.
    fn render_unavailable_video(&self, name: &str) -> AnyElement {
        let white = |alpha: f32| Hsla {
            h: 0.0,
            s: 0.0,
            l: 1.0,
            a: alpha,
        };
        div()
            .w_full()
            .aspect_ratio(4.0 / 3.0)
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(4.0))
            .px(px(8.0))
            .py(px(12.0))
            .bg(Hsla {
                h: 0.0,
                s: 0.0,
                l: 0.0,
                a: 1.0,
            })
            .text_size(px(12.0))
            .line_height(px(16.0))
            .text_center()
            .text_color(white(0.7))
            .child(
                div()
                    .min_w_0()
                    .max_w_full()
                    .truncate()
                    .child(name.to_owned()),
            )
            .child(div().text_color(white(0.5)).child("Video unavailable"))
            .into_any_element()
    }

    /// One run of files as a stack of dark inset rows, 3px apart: the file icon and name on the
    /// left, the size on the right, never closer than 16px. A row saves its file through the
    /// native Save dialog (web's `<a download>`); it never opens the file. A file the server
    /// cannot serve reads "Sending…" and does nothing.
    fn render_file_rows(
        &self,
        key: &str,
        start: usize,
        run: &[conn_contract::ChatAttachment],
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        use super::attachment_thumb::{
            GALLERY_INSET_PX, attachment_downloadable, attachment_size_label, file_row_radii,
        };
        let surface = super::color::message_inset_surface(&self.tokens);
        let fg = hsla(self.tokens.foreground);
        let muted = hsla_alpha(self.tokens.foreground, 0.68);
        let mut stack = div()
            .flex()
            .flex_col()
            .gap(px(GALLERY_INSET_PX))
            .min_w_0()
            .text_color(fg);
        for (offset, att) in run.iter().enumerate() {
            let idx = start + offset;
            let (id, name, size) = match att {
                conn_contract::ChatAttachment::File(file) => {
                    (&file.id, &file.name, file.size_bytes)
                }
                conn_contract::ChatAttachment::Unknown(unknown) => {
                    (&unknown.id, &unknown.name, unknown.size_bytes)
                }
                conn_contract::ChatAttachment::Image(image) => {
                    (&image.id, &image.name, image.size_bytes)
                }
            };
            let radii = file_row_radii(offset, run.len());
            let file_icon = crate::file_icons::file_icon(name);
            let downloadable = attachment_downloadable(id);
            let (save_id, save_name) = (id.clone(), name.clone());
            let row = div()
                .id((SharedString::from(format!("att-{key}")), idx))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.0))
                .min_w_0()
                .px(px(13.0))
                .py(px(10.0))
                .rounded_tl(px(radii.top_left))
                .rounded_tr(px(radii.top_right))
                .rounded_br(px(radii.bottom_right))
                .rounded_bl(px(radii.bottom_left))
                .bg(surface)
                .conn_tooltip(name.clone(), &self.tokens);
            let row = if downloadable {
                row.a11y_button(
                    format!("chat.attachment.{key}.{idx}"),
                    format!("Save attachment {name}"),
                )
                .cursor_pointer()
                .on_click(cx.listener(move |view, _, _, cx| {
                    view.save_attachment(&save_id, &save_name, cx);
                }))
            } else {
                row.a11y_group(
                    format!("chat.attachment.{key}.{idx}"),
                    format!("Attachment {name}, sending"),
                )
                .opacity(0.6)
            };
            stack = stack.child(
                row.child(icons::icon(file_icon.asset, 14.0, muted))
                    .child(
                        div()
                            .min_w_0()
                            .mr(px(8.0))
                            .font_weight(FontWeight::MEDIUM)
                            .child(name.clone()),
                    )
                    .child(
                        div()
                            .flex_none()
                            .ml_auto()
                            .whitespace_nowrap()
                            .text_color(muted)
                            .child(if downloadable {
                                attachment_size_label(size)
                            } else {
                                "Sending…".to_owned()
                            }),
                    ),
            );
        }
        stack.into_any_element()
    }

    /// Saves a sent file where the user says: the native Save dialog opens on Downloads with the
    /// file's own name, and nothing is fetched until a place is chosen. The file is never opened.
    /// Any failure (no connection, the download, the write) shows in the chat's error banner.
    fn save_attachment(&mut self, id: &str, name: &str, cx: &mut Context<'_, Self>) {
        let file_name = super::attachment_thumb::attachment_save_name(name);
        let Some(connection) = self.connection.clone() else {
            self.set_error(
                Some(format!("Could not save {file_name}: not connected")),
                cx,
            );
            return;
        };
        let directory = std::env::var_os("HOME")
            .map(|home| std::path::PathBuf::from(home).join("Downloads"))
            .filter(|folder| folder.is_dir())
            .unwrap_or_else(std::env::temp_dir);
        let prompt = cx.prompt_for_new_path(&directory, Some(&file_name));
        let id = id.to_owned();
        cx.spawn(async move |this, cx| {
            let outcome: Result<(), String> = async {
                let chosen = match prompt.await {
                    Ok(Ok(Some(path))) => path,
                    // The user closed the dialog.
                    Ok(Ok(None)) | Err(_) => return Ok(()),
                    Ok(Err(err)) => return Err(err.to_string()),
                };
                let bytes = connection
                    .fetch_attachment_bytes(&id)
                    .await
                    .map_err(|err| err.to_string())?;
                cx.background_executor()
                    .spawn(async move { std::fs::write(&chosen, bytes).map_err(|e| e.to_string()) })
                    .await
            }
            .await;
            if let Err(reason) = outcome {
                let _ = this.update(cx, |view, cx| {
                    view.set_error(Some(format!("Could not save {file_name}: {reason}")), cx);
                });
            }
        })
        .detach();
    }

    /// One review comment of a sent message: the quoted diff lines in a dark inset, headed by the
    /// file and line (`app.rs · #12`). The user's own note is the bubble's caption, above it.
    pub(super) fn render_review_comment(
        &self,
        key: &str,
        idx: usize,
        comment: &conn_state::ReviewComment,
    ) -> AnyElement {
        use super::attachment_thumb::GALLERY_INSET_PX;
        let muted = hsla(self.tokens.muted_foreground);
        let code_fg = hsla(self.tokens.code_foreground);
        let added = hsla(self.tokens.diff_added);
        let removed = hsla(self.tokens.diff_removed);
        let label = comment.label();
        let file_icon = crate::file_icons::file_icon(&comment.file_path);
        let mut body = div()
            .flex()
            .flex_col()
            .min_w_0()
            .overflow_hidden()
            .rounded(px(super::BUBBLE_RADIUS_PX - 2.0 * GALLERY_INSET_PX))
            .bg(hsla(self.tokens.code_background))
            .px(px(14.0))
            .py(px(12.0))
            .font_family(MONO_FONT_FAMILY)
            .text_size(px(13.0))
            .line_height(px(13.0 * 1.625))
            .text_color(code_fg);
        for line in comment.diff.lines() {
            let color = match line.chars().next() {
                Some('+') => added,
                Some('-') => removed,
                _ => code_fg,
            };
            // An empty line keeps its height.
            let shown = if line.is_empty() { " " } else { line };
            body = body.child(
                div()
                    .whitespace_nowrap()
                    .text_color(color)
                    .child(shown.to_owned()),
            );
        }
        div()
            .id(SharedString::from(format!("review-{key}-{idx}")))
            .a11y_group(format!("chat.review.{key}.{idx}"), label.clone())
            .flex()
            .flex_col()
            .min_w_0()
            .gap(px(GALLERY_INSET_PX))
            .p(px(GALLERY_INSET_PX))
            .rounded(px(super::BUBBLE_RADIUS_PX - GALLERY_INSET_PX))
            .bg(super::color::message_inset_surface(&self.tokens))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.0))
                    .min_h(px(30.0 - GALLERY_INSET_PX))
                    .px(px(11.0))
                    .text_size(px(UI_FONT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child(icons::icon(file_icon.asset, 14.0, muted))
                    .child(div().min_w_0().truncate().child(label)),
            )
            .when(!comment.diff.is_empty(), |card| card.child(body))
            .into_any_element()
    }

    fn attachment_pill(
        &self,
        id: (SharedString, usize),
        name: String,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        div()
            .id(id)
            .flex()
            .flex_row()
            .items_center()
            .gap(px(4.0))
            .h(px(24.0))
            .max_w(px(200.0))
            .px(px(8.0))
            .rounded(px(6.0))
            .bg(hsla_alpha(self.tokens.muted, 0.45))
            .border_1()
            .border_color(hsla_alpha(self.tokens.border, 0.70))
            .text_size(px(12.0))
            .line_height(px(16.0))
            .text_color(hsla(self.tokens.muted_foreground))
            .conn_tooltip(name, &self.tokens)
    }

    /// Conn `UserMessageIntentMarker`: `Redo2` + `Steer` above a steering bubble.
    pub(super) fn render_steer_marker(&self, id: &str) -> AnyElement {
        let muted = hsla(self.tokens.muted_foreground);
        div()
            .id(SharedString::from(format!("steer-{id}")))
            .a11y_group(format!("chat.steer.{id}"), "Steered the active turn")
            .mr(px(4.0))
            .mb(px(4.0))
            .flex()
            .flex_row()
            .items_center()
            .justify_end()
            .gap(px(4.0))
            .text_size(px(12.0))
            .line_height(px(12.0))
            .text_color(muted)
            .conn_tooltip("Steered the active turn", &self.tokens)
            .child(icons::icon(icons::REDO, 12.0, muted))
            .child("Steer")
            .into_any_element()
    }

    /// Conn `messageActions` under a user bubble: timestamp + Copy, revealed on row hover.
    pub(super) fn render_user_actions(
        &self,
        id: &str,
        text: &str,
        created_at: Option<&str>,
        group: &SharedString,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let mut actions = div()
            .id(SharedString::from(format!("user-actions-{id}")))
            .a11y_group(format!("chat.user.{id}.actions"), "Message actions")
            .flex()
            .flex_row()
            .items_center()
            .justify_end()
            .gap(px(4.0))
            .opacity(0.0)
            .group_hover(group.clone(), |s| s.opacity(1.0));
        if let Some(ts) = self.render_timestamp(&format!("user-{id}"), created_at) {
            actions = actions.child(ts);
        }
        if !text.trim().is_empty() {
            actions = actions.child(self.render_copy_button(
                &format!("user-{id}"),
                "Copy message",
                text.to_owned(),
                cx,
            ));
        }
        actions.into_any_element()
    }

    /// Conn `AssistantMessageMeta`: non-completed status badge, Copy, Fork from this response,
    /// and the day-aware timestamp, revealed on hover.
    #[expect(
        clippy::too_many_arguments,
        reason = "mirrors the Conn component props one to one"
    )]
    pub(super) fn render_assistant_meta(
        &self,
        id: &str,
        markdown: &str,
        status: conn_state::ItemStatus,
        run_id: Option<&str>,
        created_at: Option<&str>,
        group: &SharedString,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let muted = hsla(self.tokens.muted_foreground);
        let fg = hsla(self.tokens.foreground);
        let hover_bg = hsla_alpha(self.tokens.foreground, 0.06);
        let mut meta = div()
            .id(SharedString::from(format!("assistant-actions-{id}")))
            .a11y_group(format!("chat.assistant.{id}.actions"), "Message actions")
            .mt(px(6.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(4.0))
            .opacity(0.0)
            .group_hover(group.clone(), |s| s.opacity(1.0));
        if status != conn_state::ItemStatus::Completed {
            let label = match status {
                conn_state::ItemStatus::Running => "running",
                conn_state::ItemStatus::Failed => "failed",
                conn_state::ItemStatus::Completed => "completed",
            };
            meta = meta.child(
                div()
                    .id(SharedString::from(format!("assistant-status-{id}")))
                    .a11y(
                        gpui_kit::Role::Status,
                        format!("chat.assistant.{id}.status"),
                        format!("Message {label}"),
                    )
                    .px(px(6.0))
                    .py(px(2.0))
                    .rounded_full()
                    .border_1()
                    .border_color(hsla_alpha(self.tokens.border, 0.70))
                    .font_family(MONO_FONT_FAMILY)
                    .text_size(px(10.0))
                    .line_height(px(12.0))
                    .text_color(muted)
                    .child(label),
            );
        }
        if !markdown.trim().is_empty() {
            let markdown = markdown.to_owned();
            meta = meta.child(self.render_copy_action(
                &format!("assistant-{id}"),
                "Copy message",
                move || super::artifact_template::message_copy_text(&markdown),
                cx,
            ));
        }
        // `canForkProjectedAssistantItem`: completed assistant messages with a run.
        if status == conn_state::ItemStatus::Completed
            && let Some(run_id) = run_id
        {
            let run_id = run_id.to_owned();
            meta = meta.child(
                div()
                    .id(SharedString::from(format!("fork-{id}")))
                    .a11y_button(
                        SharedString::from(format!("chat.fork.{id}")),
                        "Fork from this response",
                    )
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(CARD_ACTION_BOX_PX))
                    .rounded(px(6.0))
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover_bg).text_color(fg))
                    .on_click(cx.listener(move |_, _, _, cx| {
                        cx.emit(ChatEvent::ForkFromRun {
                            run_id: run_id.clone(),
                        });
                    }))
                    .conn_tooltip("Fork from this response", &self.tokens)
                    .child(icons::icon(icons::FORK, CARD_ACTION_ICON_PX, muted)),
            );
        }
        if let Some(ts) = self.render_timestamp(&format!("assistant-{id}"), created_at) {
            meta = meta.child(ts);
        }
        meta.into_any_element()
    }

    // -----------------------------------------------------------------------------------------
    // Card inputs (created during render, where a `Window` exists)
    // -----------------------------------------------------------------------------------------

    /// Creates input fields for pending question and secret cards and drops stale ones.
    pub(super) fn ensure_card_inputs(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let pending = self.pending_card_ids.clone();
        self.secret_forms.retain(|id, _| pending.contains(id));
        self.user_input_cards.retain(|id, _| pending.contains(id));
        self.question_panel.displaced.retain_keys(|key| {
            pending.iter().any(|id| {
                key.strip_prefix(id.as_str())
                    .is_some_and(|rest| rest.starts_with(':'))
            })
        });
        for id in pending {
            let Some(entry) = self
                .cache
                .rows()
                .iter()
                .find(|row| row.entry.id() == id)
                .map(|row| row.entry.clone())
            else {
                continue;
            };
            match entry {
                TimelineEntry::SecretRequest { placeholder, .. } => {
                    if self.secret_forms.contains_key(&id) {
                        continue;
                    }
                    let placeholder =
                        placeholder.unwrap_or_else(|| SECRET_DEFAULT_PLACEHOLDER.to_owned());
                    let input = cx.new(|cx| {
                        InputState::new(window, cx)
                            .masked(true)
                            .placeholder(placeholder)
                    });
                    let entry_id = id.clone();
                    let subscription = cx.subscribe_in(
                        &input,
                        window,
                        move |view, _, event: &InputEvent, _, cx| match event {
                            InputEvent::PressEnter { .. } => {
                                view.submit_secret(&entry_id, false, cx);
                            }
                            InputEvent::Change => cx.notify(),
                            _ => {}
                        },
                    );
                    self.secret_forms.insert(
                        id,
                        SecretFormState {
                            input,
                            submitting: false,
                            error: None,
                            _subscription: subscription,
                        },
                    );
                }
                TimelineEntry::UserInputRequest { .. } => {
                    self.user_input_cards
                        .entry(id.clone())
                        .or_insert_with(UserInputCardState::new);
                }
                _ => {}
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // Pending user input
    // -----------------------------------------------------------------------------------------

    pub(super) fn user_input_questions(
        &self,
        entry_id: &str,
    ) -> Option<(String, Vec<UserInputQuestion>)> {
        self.cache.rows().iter().find_map(|row| match &row.entry {
            TimelineEntry::UserInputRequest {
                id,
                request_id,
                questions,
                ..
            } if id == entry_id => Some((request_id.clone(), questions.clone())),
            _ => None,
        })
    }

    pub(super) fn select_user_input_option(
        &mut self,
        entry_id: &str,
        question: &UserInputQuestion,
        value: &str,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if self
            .user_input_cards
            .get(entry_id)
            .is_none_or(|state| state.responding)
        {
            return;
        }
        self.set_aside_typed_answer(entry_id, question, window, cx);
        let Some(state) = self.user_input_cards.get_mut(entry_id) else {
            return;
        };
        let next = question.toggle_option(state.drafts.get(&question.id), value);
        state.drafts.insert(question.id.clone(), next);
        if !question.multi_select {
            let entry_id = entry_id.to_owned();
            state._auto_advance = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(AUTO_ADVANCE_DELAY).await;
                let _ = this.update(cx, |view, cx| view.advance_user_input(&entry_id, cx));
            }));
        }
        cx.notify();
    }

    fn set_user_input_custom(
        &mut self,
        entry_id: &str,
        question: &UserInputQuestion,
        text: &str,
        cx: &mut Context<'_, Self>,
    ) {
        if let Some(state) = self.user_input_cards.get_mut(entry_id) {
            let next = question.set_custom_answer(state.drafts.get(&question.id), text);
            state.drafts.insert(question.id.clone(), next);
            cx.notify();
        }
    }

    /// Moves to the next question once the active one is answered; submits on the last one
    /// (`onAdvanceActivePendingUserInput`, which ignores a request nobody can answer).
    pub(super) fn advance_user_input(&mut self, entry_id: &str, cx: &mut Context<'_, Self>) {
        if !self.question_panel.can_respond {
            return;
        }
        let Some((_, questions)) = self.user_input_questions(entry_id) else {
            return;
        };
        let Some(state) = self.user_input_cards.get_mut(entry_id) else {
            return;
        };
        state._auto_advance = None;
        let index = state.question_index.min(questions.len().saturating_sub(1));
        let Some(question) = questions.get(index) else {
            return;
        };
        if question
            .resolve_answer(state.drafts.get(&question.id))
            .is_none()
        {
            return;
        }
        if index + 1 < questions.len() {
            state.question_index = index + 1;
            cx.notify();
        } else {
            self.submit_user_input(entry_id, cx);
        }
    }

    pub(super) fn go_back_user_input(&mut self, entry_id: &str, cx: &mut Context<'_, Self>) {
        if let Some(state) = self.user_input_cards.get_mut(entry_id)
            && state.question_index > 0
        {
            state.question_index -= 1;
            state._auto_advance = None;
            cx.notify();
        }
    }

    /// Sends every answer with `runtime-request.respond`.
    fn submit_user_input(&mut self, entry_id: &str, cx: &mut Context<'_, Self>) {
        let Some((request_id, questions)) = self.user_input_questions(entry_id) else {
            return;
        };
        let (Some(connection), Some(thread_id)) = (self.connection.clone(), self.thread_id.clone())
        else {
            return;
        };
        let Some(state) = self.user_input_cards.get_mut(entry_id) else {
            return;
        };
        if state.responding {
            return;
        }
        let Some(answers) = build_user_input_answers(&questions, &state.drafts) else {
            return;
        };
        let answers: serde_json::Map<String, serde_json::Value> = answers
            .into_iter()
            .map(|(qid, value)| (qid, value.to_json()))
            .collect();
        let command = match crate::commands::respond_user_input(&thread_id, &request_id, &answers) {
            Ok(command) => command,
            Err(err) => {
                state.error = Some(format!("Could not build the answer: {err}"));
                cx.notify();
                return;
            }
        };
        state.responding = true;
        state.error = None;
        let entry_id = entry_id.to_owned();
        let epoch = self.card_epoch;
        cx.spawn(async move |this, cx| {
            let result = connection.dispatch_command(command).await;
            let _ = this.update(cx, |view, cx| {
                if view.card_epoch != epoch {
                    return;
                }
                if let Some(state) = view.user_input_cards.get_mut(&entry_id) {
                    // An answered question stays locked until its entry settles, so a second
                    // click cannot answer it twice.
                    state.responding = result.is_ok();
                    if let Err(err) = result {
                        state.error = Some(crate::commands::format_client_error(&err));
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// The pending approval and active question a composer send answers.
    pub(super) fn composer_pending_request(&self) -> ComposerPendingRequest {
        let question = self.pending_question_id.as_deref().and_then(|entry_id| {
            let questions = self.user_input_questions(entry_id)?.1;
            let state = self.user_input_cards.get(entry_id);
            let index = state
                .map_or(0, |s| s.question_index)
                .min(questions.len().saturating_sub(1));
            let question = questions.get(index)?;
            let draft = state.and_then(|s| s.drafts.get(&question.id));
            Some(PendingQuestion {
                allow_custom_answer: question.allow_custom_answer,
                has_options: !question.options.is_empty(),
                answered: question.resolve_answer(draft).is_some(),
            })
        });
        ComposerPendingRequest {
            approval: self.pending_approval,
            question,
        }
    }

    /// Answers the active pending question from the composer: typed text becomes its answer,
    /// blank keeps the selected option, then the card moves on or submits
    /// (`onChangeActivePendingUserInputCustomAnswer` + `onAdvanceActivePendingUserInput`).
    pub(super) fn answer_pending_question(&mut self, text: &str, cx: &mut Context<'_, Self>) {
        let Some(entry_id) = self.pending_question_id.clone() else {
            return;
        };
        let Some((_, questions)) = self.user_input_questions(&entry_id) else {
            return;
        };
        let state = self
            .user_input_cards
            .entry(entry_id.clone())
            .or_insert_with(UserInputCardState::new);
        let index = state.question_index.min(questions.len().saturating_sub(1));
        if let Some(question) = questions.get(index)
            && !text.trim().is_empty()
        {
            self.withdraw_restored_answer(&entry_id, &question.id, text, cx);
            self.set_user_input_custom(&entry_id, question, text, cx);
        }
        self.advance_user_input(&entry_id, cx);
    }

    /// Dismisses a message-mode question (`thread.user-input.dismiss`).
    pub(super) fn dismiss_user_input(&mut self, entry_id: &str, cx: &mut Context<'_, Self>) {
        let Some((request_id, _)) = self.user_input_questions(entry_id) else {
            return;
        };
        let (Some(connection), Some(thread_id)) = (self.connection.clone(), self.thread_id.clone())
        else {
            return;
        };
        let Ok(command) = crate::commands::dismiss_user_input(&thread_id, &request_id) else {
            return;
        };
        if let Some(state) = self.user_input_cards.get_mut(entry_id) {
            if state.responding {
                return;
            }
            state.responding = true;
        }
        let entry_id = entry_id.to_owned();
        let epoch = self.card_epoch;
        cx.spawn(async move |this, cx| {
            let result = connection.dispatch_command(command).await;
            let _ = this.update(cx, |view, cx| {
                if view.card_epoch != epoch {
                    return;
                }
                if let Some(state) = view.user_input_cards.get_mut(&entry_id) {
                    state.responding = result.is_ok();
                    if let Err(err) = result {
                        state.error = Some(crate::commands::format_client_error(&err));
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// A question's timeline row. Conn shows a pending one in the request stack above the composer
    /// ([`ChatView::render_question_panel`]) and leaves an empty row here until it settles, then the answers.
    #[expect(
        clippy::too_many_arguments,
        reason = "mirrors the Conn component props one to one"
    )]
    pub(super) fn render_user_input_card(
        &self,
        id: &str,
        title: Option<&str>,
        questions: &[UserInputQuestion],
        pending: bool,
        status: TurnItemStatus,
        answers: &[UserInputAnswer],
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        self.render_user_input_history(id, title, questions, pending, status, answers, cx)
    }

    /// Answered or ended question: a `WorkLogRow` with each `question · answer`.
    #[expect(
        clippy::too_many_arguments,
        reason = "mirrors the Conn component props one to one"
    )]
    fn render_user_input_history(
        &self,
        id: &str,
        title: Option<&str>,
        questions: &[UserInputQuestion],
        pending: bool,
        status: TurnItemStatus,
        answers: &[UserInputAnswer],
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        // A pending question is answered in the request stack; its row appears once it settles.
        // The empty row still splits the work around it.
        if pending {
            return div().into_any_element();
        }
        let muted = hsla(self.tokens.muted_foreground);
        let label = if !answers.is_empty() {
            title.map_or_else(
                || {
                    if answers.len() == 1 {
                        "Answered a question".to_owned()
                    } else {
                        format!("Answered {} questions", answers.len())
                    }
                },
                str::to_owned,
            )
        } else {
            match status {
                TurnItemStatus::Cancelled | TurnItemStatus::Interrupted => {
                    "Question dismissed".to_owned()
                }
                TurnItemStatus::Failed => "Question failed".to_owned(),
                _ => title
                    .map(str::to_owned)
                    .or_else(|| questions.first().map(|q| q.header.clone()))
                    .unwrap_or_else(|| "Question".to_owned()),
            }
        };
        let key = format!("{id}:history");
        let expanded = self.expanded_ids.contains(&key);
        let has_body = !answers.is_empty();
        let toggle = key.clone();
        let mut line = self
            .work_log_line(&key, icons::CHAT_CIRCLE, &label, has_body, expanded)
            .when(has_body, |d| {
                d.on_click(cx.listener(move |view, _, _, cx| view.toggle_expanded(&toggle, cx)))
            });
        line = line.text_color(muted);
        let mut col = div()
            .flex()
            .flex_col()
            .w_full()
            .min_w_0()
            .pb(px(8.0))
            .child(line);
        if expanded {
            let mut list = div()
                .ml(px(28.0))
                .flex()
                .flex_col()
                .gap(px(6.0))
                .py(px(4.0))
                .text_size(px(UI_FONT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX));
            for answer in answers {
                list = list.child(
                    div()
                        .flex()
                        .flex_col()
                        .child(div().text_color(muted).child(answer.question.clone()))
                        .child(div().text_color(prose_foreground(&self.tokens)).child(
                            if answer.answer.is_empty() {
                                "(no text)".to_owned()
                            } else {
                                answer.answer.clone()
                            },
                        )),
                );
            }
            col = col.child(list);
        }
        col.into_any_element()
    }

    /// Conn `OptionRadio`: `size-4` circle, primary fill with a foreground dot when checked.
    pub(super) fn render_option_radio(&self, checked: bool) -> AnyElement {
        let mut radio = div()
            .flex()
            .items_center()
            .justify_center()
            .size(px(16.0))
            .flex_none()
            .rounded_full()
            .border_1();
        radio = if checked {
            radio
                .border_color(hsla(self.tokens.primary))
                .bg(hsla(self.tokens.primary))
                .child(
                    div()
                        .size(px(6.0))
                        .rounded_full()
                        .bg(hsla(self.tokens.primary_foreground)),
                )
        } else {
            radio
                .border_color(hsla_alpha(self.tokens.foreground, 0.55))
                .bg(hsla(self.tokens.background))
        };
        radio.into_any_element()
    }

    /// Conn `CheckboxMark`: `size-4` rounded square, primary fill with a check when checked.
    pub(super) fn render_checkbox_mark(&self, checked: bool) -> AnyElement {
        let mut mark = div()
            .flex()
            .items_center()
            .justify_center()
            .size(px(16.0))
            .flex_none()
            .rounded(px(4.0))
            .border_1();
        mark = if checked {
            mark.border_color(hsla(self.tokens.primary))
                .bg(hsla(self.tokens.primary))
                .child(icons::icon(
                    icons::CHECK,
                    12.0,
                    hsla(self.tokens.primary_foreground),
                ))
        } else {
            mark.border_color(hsla(self.tokens.input))
                .bg(hsla(self.tokens.background))
        };
        mark.into_any_element()
    }

    // -----------------------------------------------------------------------------------------
    // Secret requests
    // -----------------------------------------------------------------------------------------

    /// Saves (`decline == false`) or declines the secret via `secrets.answerRequest`.
    fn submit_secret(&mut self, entry_id: &str, decline: bool, cx: &mut Context<'_, Self>) {
        let (Some(connection), Some(thread_id)) = (self.connection.clone(), self.thread_id.clone())
        else {
            return;
        };
        let Some(form) = self.secret_forms.get_mut(entry_id) else {
            return;
        };
        if form.submitting {
            return;
        }
        let secret = (!decline).then(|| form.input.read(cx).value().to_string());
        // Enter in an empty field saves nothing.
        if secret
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
        {
            return;
        }
        let Some(payload) =
            crate::commands::secret_answer_payload(&thread_id, entry_id, secret.as_deref())
        else {
            return;
        };
        form.submitting = true;
        form.error = None;
        let entry_id = entry_id.to_owned();
        let epoch = self.card_epoch;
        cx.spawn(async move |this, cx| {
            let result = connection
                .call_json(crate::commands::SECRETS_ANSWER_REQUEST, payload)
                .await;
            let _ = this.update(cx, |view, cx| {
                // The thread changed meanwhile: its form, and the secret in it, is gone.
                if view.card_epoch != epoch {
                    return;
                }
                let Some(form) = view.secret_forms.get_mut(&entry_id) else {
                    return;
                };
                // An answered request stays locked until its entry settles, so a second click
                // cannot send the secret twice.
                form.submitting = result.is_ok();
                // `secretRequestFailureMessage`: never surface transport details.
                if let Err(err) = result {
                    let message = crate::commands::format_client_error(&err);
                    form.error = Some(if message.trim().is_empty() {
                        "Could not answer the request. Try again.".to_owned()
                    } else {
                        message
                    });
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// A secret request's timeline row once it settles. A pending request is answered in the
    /// request stack above the composer ([`ChatView::render_secret_panel`]); its row stays empty
    /// so the work around it stays split.
    pub(super) fn render_secret_card(
        &self,
        id: &str,
        label: &str,
        status: SecretRequestStatus,
        pending: bool,
    ) -> AnyElement {
        if pending {
            return div().into_any_element();
        }
        let (icon, display) = match status {
            SecretRequestStatus::Saved => (icons::CHECK, "Saved securely and kept private"),
            SecretRequestStatus::Declined => (icons::MINUS, "Declined"),
            SecretRequestStatus::Cancelled => (icons::MINUS, "Request ended"),
            SecretRequestStatus::Pending => {
                (icons::LOCK, "Waiting for an answer in the original thread")
            }
        };
        div()
            .w_full()
            .min_w_0()
            .pb(px(8.0))
            .child(
                self.work_log_line(
                    &format!("secret-{id}"),
                    icon,
                    &format!("{label} · {display}"),
                    false,
                    false,
                )
                .text_color(hsla(self.tokens.muted_foreground)),
            )
            .into_any_element()
    }

    /// The pending secret request as a card of the request stack: the masked field, then Decline
    /// and Save below it. The secret lives only in the field until it is sent.
    pub(super) fn render_secret_panel(
        &self,
        id: &str,
        body_max: f32,
        cx: &mut Context<'_, Self>,
    ) -> Option<AnyElement> {
        let (label, reason, url, file_delivery) =
            self.cache.rows().iter().find_map(|row| match &row.entry {
                TimelineEntry::SecretRequest {
                    id: entry_id,
                    label,
                    reason,
                    url,
                    file_delivery,
                    ..
                } if entry_id == id => {
                    Some((label.clone(), reason.clone(), url.clone(), *file_delivery))
                }
                _ => None,
            })?;
        let form = self.secret_forms.get(id)?;
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground);
        let has_value = !form.input.read(cx).value().trim().is_empty();
        let submitting = form.submitting;

        let mut content = div()
            .flex()
            .flex_col()
            .gap(px(10.0))
            .px(px(17.0))
            .py(px(16.0))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .min_w_0()
                    .child(
                        div()
                            .text_size(px(BODY_FONT_PX))
                            .line_height(px(20.0))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(fg)
                            .child(label.clone()),
                    )
                    .when(!reason.trim().is_empty(), |d| {
                        d.child(
                            div()
                                .text_size(px(BODY_FONT_PX))
                                .line_height(px(20.0))
                                .text_color(muted)
                                .child(reason.clone()),
                        )
                    }),
            )
            .child(
                div()
                    .w_full()
                    .min_w_0()
                    .child(Input::new(&form.input).disabled(submitting)),
            );
        if let Some(error) = &form.error {
            content = content.child(
                div()
                    .text_size(px(UI_FONT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(hsla(self.tokens.destructive))
                    .child(error.clone()),
            );
        }
        let note = if file_delivery {
            "Kept out of chat, in a private file this agent's commands can read for 24 hours"
        } else {
            "Stored securely, never shown to the agent"
        };
        content = content.child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.0))
                .min_w_0()
                .text_size(px(UI_FONT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(muted)
                .child(icons::icon(icons::SHIELD_CHECK, 14.0, muted))
                .child(div().min_w_0().child(note)),
        );
        let body = div()
            .id(SharedString::from(format!("secret-scroll-{id}")))
            .max_h(px(body_max))
            .overflow_y_scroll()
            .child(content)
            .into_any_element();

        use gpui_kit::TestSupportExt as _;
        let mut actions = Self::request_actions();
        if let Some(url) = url {
            actions = actions.child(
                self.ghost_button(&format!("secret-url-{id}"), "Open sign-in page", true, cx)
                    .child(icons::icon(icons::EXTERNAL_LINK, 12.0, muted))
                    .on_click(move |_, _, cx| cx.open_url(&url)),
            );
        }
        actions = actions.child(div().flex_1());
        let decline_id = id.to_owned();
        let save_id = id.to_owned();
        actions = actions
            .child(
                self.request_pill(
                    format!("secret-decline-{id}"),
                    format!("chat.secret-decline-{id}"),
                    "Decline",
                    "secondary",
                    !submitting,
                )
                .when(!submitting, |pill| {
                    pill.on_click(cx.listener(move |view, _, _, cx| {
                        view.submit_secret(&decline_id, true, cx);
                    }))
                })
                .test_support(),
            )
            .child(
                self.request_pill(
                    format!("secret-save-{id}"),
                    format!("chat.secret-save-{id}"),
                    "Save",
                    "accept",
                    !submitting && has_value,
                )
                .when(!submitting && has_value, |pill| {
                    pill.on_click(cx.listener(move |view, _, _, cx| {
                        view.submit_secret(&save_id, false, cx);
                    }))
                })
                .test_support(),
            );

        Some(
            self.request_panel(
                SharedString::from(format!("secret-card-{id}")),
                SharedString::from(format!("chat.secret.{id}")),
                SharedString::from(label),
                icons::LOCK,
                "Secret request",
                None,
                body,
                actions.into_any_element(),
                hsla(super::request_stack::panel_colors(&self.tokens).inner),
            )
            .into_any_element(),
        )
    }

    // -----------------------------------------------------------------------------------------
    // Proposed plan
    // -----------------------------------------------------------------------------------------

    pub(super) fn render_plan_card(
        &self,
        id: &str,
        title: &str,
        plan_markdown: &str,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let key = format!("{id}:plan");
        let expanded = self.expanded_ids.contains(&key);
        let can_collapse = plan_can_collapse(plan_markdown);
        let is_collapsed = can_collapse && !expanded;
        let body_md = if is_collapsed {
            collapsed_plan_preview(plan_markdown, PLAN_PREVIEW_MAX_LINES)
        } else {
            strip_displayed_plan_markdown(plan_markdown)
        };
        let colors = card_colors(&self.tokens, CardFace::Plain);
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground);

        let mut options = self.markdown_options(cx);
        options.prose = Some(markdown::ProseStyle {
            color: prose_foreground(&self.tokens),
            size: Some((CARD_TEXT_PX, CARD_LINE_PX)),
        });
        let mut text = div()
            .relative()
            .w_full()
            .min_w_0()
            .child(markdown::render_markdown(
                id,
                &body_md,
                &self.tokens,
                &options,
            ));
        if is_collapsed {
            // Ends in the colour of the body, opaque, so no band is visible.
            let (hidden, shown) = super::color::fade_ends(colors.body);
            text = text.max_h(px(416.0)).overflow_hidden().child(
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    .bottom_0()
                    .h(px(96.0))
                    .bg(linear_gradient(
                        0.0,
                        linear_color_stop(hidden, 0.0),
                        linear_color_stop(shown, 1.0),
                    )),
            );
        }

        let copy_text = normalize_plan_markdown_for_export(plan_markdown);
        let download = self.render_download_button(
            &format!("plan-{id}"),
            "Download plan",
            "plan.md".to_owned(),
            copy_text.clone(),
            cx,
        );
        let header = card_header(true)
            .child(icons::icon(CHECKLIST, CARD_ICON_PX, muted))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(CARD_TEXT_PX))
                    .line_height(px(CARD_TEXT_PX * 1.5))
                    .text_color(muted)
                    .child("Proposed plan"),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(2.0))
                    .child(self.render_copy_button(
                        &format!("plan-{id}"),
                        "Copy to clipboard",
                        copy_text,
                        cx,
                    ))
                    .child(download),
            );
        let mut body = card_body(colors)
            .flex()
            .flex_col()
            .gap(px(6.0))
            .child(
                div()
                    .text_size(px(CARD_TEXT_PX))
                    .line_height(px(CARD_LINE_PX))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(fg)
                    .child(title.to_owned()),
            )
            .child(text);
        if can_collapse {
            let toggle = key;
            body = body.child(
                div().mt(px(10.0)).flex().justify_center().child(
                    self.outline_button(
                        &format!("plan-toggle-{id}"),
                        if expanded {
                            "Collapse plan"
                        } else {
                            "Expand plan"
                        },
                    )
                    .on_click(cx.listener(move |view, _, _, cx| view.toggle_expanded(&toggle, cx))),
                ),
            );
        }
        let card = card_shell(colors)
            .id(SharedString::from(format!("plan-card-{id}")))
            .a11y(
                gpui_kit::Role::Article,
                SharedString::from(format!("chat.plan.{id}")),
                title.to_owned(),
            )
            .child(header)
            .child(body);
        div()
            .w_full()
            .min_w_0()
            .pb(px(16.0))
            .child(card)
            .into_any_element()
    }

    /// A 24px header button that saves `contents` to a file the user names.
    fn render_download_button(
        &self,
        key: &str,
        label: &'static str,
        file_name: String,
        contents: String,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground);
        let hover_bg = hsla_alpha(self.tokens.foreground, 0.06);
        div()
            .id(SharedString::from(format!("download-{key}")))
            .a11y_button(SharedString::from(format!("chat.download.{key}")), label)
            .flex()
            .items_center()
            .justify_center()
            .size(px(CARD_ACTION_BOX_PX))
            .rounded(px(6.0))
            .cursor_pointer()
            .hover(move |s| s.bg(hover_bg).text_color(fg))
            .on_click(cx.listener(move |view, _, _, cx| {
                view.save_text_file(file_name.clone(), contents.clone(), cx);
            }))
            .conn_tooltip(label, &self.tokens)
            .child(icons::icon(DOWNLOAD, CARD_ACTION_ICON_PX, muted))
            .into_any_element()
    }

    /// Asks where to save `contents` (starting in Downloads) and writes it there.
    fn save_text_file(&mut self, file_name: String, contents: String, cx: &mut Context<'_, Self>) {
        let directory = std::env::var_os("HOME").map_or_else(std::env::temp_dir, |home| {
            std::path::PathBuf::from(home).join("Downloads")
        });
        let prompt = cx.prompt_for_new_path(&directory, Some(&file_name));
        cx.spawn(async move |this, cx| {
            let outcome = match prompt.await {
                Ok(Ok(Some(path))) => cx
                    .background_executor()
                    .spawn(async move { std::fs::write(path, contents).map_err(|e| e.to_string()) })
                    .await,
                Ok(Err(err)) => Err(err.to_string()),
                _ => return,
            };
            if let Err(reason) = outcome {
                let _ = this.update(cx, |view, cx| {
                    view.set_error(Some(format!("Could not save {file_name}: {reason}")), cx);
                });
            }
        })
        .detach();
    }

    // -----------------------------------------------------------------------------------------
    // Subagents (`V2LifecycleRow.tsx` `SubagentTimelineLink` + `TASK_CARD_FACE_CLASS`)
    // -----------------------------------------------------------------------------------------

    /// A delegated subagent: its provider mark with a status dot, then the model, effort and
    /// state, and the run time at the right; below, its title and what it reported. A card with a
    /// report opens and closes on a tap on its body; a tap on its header opens the subagent's own
    /// thread. A card with no report is one button for the thread.
    #[expect(
        clippy::too_many_arguments,
        reason = "mirrors the Conn component props one to one"
    )]
    pub(super) fn render_subagent_row(
        &self,
        id: &str,
        child_thread_id: Option<&str>,
        title: &str,
        role: &str,
        status: TurnItemStatus,
        summary: Option<&str>,
        remote_child: Option<&conn_contract::OrchestrationV2RemoteTaskChild>,
        started_at: Option<&str>,
        completed_at: Option<&str>,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let colors = card_colors(&self.tokens, CardFace::Tinted);
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground);
        let (_tone, status_label) = subagent_status_visual(status);
        let dot: Option<Hsla> = match status {
            TurnItemStatus::Pending | TurnItemStatus::Running => Some(hsla(self.tokens.info)),
            TurnItemStatus::Waiting => Some(hsla_alpha(self.tokens.muted_foreground, 0.70)),
            TurnItemStatus::Completed => Some(hsla(self.tokens.success)),
            TurnItemStatus::Failed => Some(hsla(self.tokens.destructive)),
            TurnItemStatus::Idle | TurnItemStatus::Cancelled | TurnItemStatus::Interrupted => None,
        };
        let working = matches!(
            status,
            TurnItemStatus::Pending | TurnItemStatus::Running | TurnItemStatus::Waiting
        );
        let failed = status == TurnItemStatus::Failed;
        let elapsed = started_at
            .and_then(conn_state::parse_iso8601_epoch_ms)
            .and_then(|start| {
                let end = if conn_state::subagent_settled(status) {
                    completed_at.and_then(conn_state::parse_iso8601_epoch_ms)?
                } else {
                    super::now_epoch_ms()
                };
                u64::try_from(end - start).ok()
            })
            .map(conn_state::format_duration);

        // Lab `SubagentCard`: `<model> · <effort>` (and the state while no time shows), the run
        // time at the right.
        let model_text = self
            .subagent_models
            .get(id)
            .and_then(|model| subagent_model_text(self.server_config.catalog(), model));
        let mut meta_parts: Vec<String> = Vec::new();
        if let Some(remote) = remote_child {
            meta_parts.push(format!("on {}", remote.label));
        }
        meta_parts.extend(model_text);
        if elapsed.is_none() {
            meta_parts.push(status_label.to_owned());
        }
        let mut header = card_header(false)
            .child(icon_with_dot(
                crate::icons::provider_mark(role, CARD_ICON_PX, muted),
                dot.map(|core| (core, colors.surface())),
            ))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(CARD_TEXT_PX))
                    .line_height(px(CARD_META_LINE_PX))
                    .text_color(muted)
                    .child(meta_parts.join(" · ")),
            );
        if let Some(elapsed) = elapsed {
            header = header.child(
                div()
                    .flex_none()
                    .whitespace_nowrap()
                    .text_size(px(CARD_TEXT_PX))
                    .line_height(px(CARD_META_LINE_PX))
                    .text_color(muted)
                    .child(elapsed),
            );
        }

        let summary = summary.map(str::trim).filter(|s| !s.is_empty());
        let expanded = self.expanded_ids.contains(&subagent_summary_key(id));
        let mut title_row = div()
            .relative()
            .text_size(px(CARD_TEXT_PX))
            .line_height(px(CARD_LINE_PX))
            .font_weight(if working {
                FontWeight::NORMAL
            } else {
                FontWeight::MEDIUM
            })
            .text_color(fg)
            .child(title.to_owned());
        let body: AnyElement = if let Some(detail) = summary {
            title_row = title_row
                .pr(px(CARD_CHEVRON_ROOM_PX))
                .child(disclosure_chevron(expanded, muted));
            let report = if expanded {
                let mut options = self.markdown_options(cx);
                options.prose = Some(markdown::ProseStyle {
                    color: prose_foreground(&self.tokens),
                    size: Some((CARD_TEXT_PX, CARD_LINE_PX)),
                });
                div()
                    .pt(px(6.0))
                    .w_full()
                    .min_w_0()
                    // Links and code buttons in the report are not a tap on the card.
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(markdown::render_markdown(
                        &format!("subagent-{id}"),
                        detail,
                        &self.tokens,
                        &options,
                    ))
            } else {
                div()
                    .pt(px(6.0))
                    .min_w_0()
                    .text_size(px(CARD_TEXT_PX))
                    .line_height(px(CARD_LINE_PX))
                    .text_color(if failed {
                        hsla(self.tokens.destructive)
                    } else {
                        muted
                    })
                    .text_ellipsis()
                    .line_clamp(CARD_PREVIEW_LINES)
                    .child(one_line_preview(detail))
            };
            let entry_id = id.to_owned();
            let toggle = card_body(colors)
                .child(title_row)
                .child(report)
                .id(SharedString::from(subagent_summary_key(id)))
                .a11y_button(
                    format!("chat.subagent.{id}.toggle"),
                    if expanded {
                        "Collapse subagent summary"
                    } else {
                        "Expand subagent summary"
                    },
                )
                .cursor_pointer()
                .on_click(cx.listener(move |view, _, _, cx| {
                    view.toggle_subagent_summary(&entry_id, cx);
                }));
            // Tests find a button by its label only when it is observed.
            #[cfg(test)]
            let toggle = {
                use gpui_kit::TestSupportExt as _;
                toggle.test_support()
            };
            toggle.into_any_element()
        } else {
            card_body(colors).child(title_row).into_any_element()
        };
        let card = card_shell(colors).id(SharedString::from(format!("subagent-{id}")));
        let open = remote_child
            .map(|remote| {
                (
                    remote.thread_id.clone(),
                    Some(remote.environment_id.clone()),
                )
            })
            .or_else(|| child_thread_id.map(|child| (child.to_owned(), None)));
        let a11y_label = format!("Subagent {title}, {status_label}");
        // A card that opens a thread lightens under the pointer, as the subagent card always did.
        let hover = card_hover_surface(colors, &self.tokens);
        let card = match (open, summary.is_some()) {
            // The header opens the thread; the body opens and closes the report.
            (Some((thread_id, environment_id)), true) => {
                let open_header = header
                    .id(SharedString::from(format!("subagent-open-{id}")))
                    .a11y_button(format!("chat.subagent.{id}.open"), format!("Open {title}"))
                    .rounded(px(CARD_BODY_RADIUS_PX))
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover))
                    .on_click(cx.listener(move |_, _, _, cx| {
                        cx.emit(ChatEvent::OpenThread {
                            thread_id: thread_id.clone(),
                            environment_id: environment_id.clone(),
                        });
                    }));
                #[cfg(test)]
                let open_header = {
                    use gpui_kit::TestSupportExt as _;
                    open_header.test_support()
                };
                card.a11y_group(format!("chat.subagent.{id}"), a11y_label)
                    .child(open_header)
                    .child(body)
            }
            // No report: the whole card is the button for the thread.
            (Some((thread_id, environment_id)), false) => card
                .a11y_button(format!("chat.subagent.{id}"), format!("Open {title}"))
                .cursor_pointer()
                .hover(move |s| s.bg(hover))
                .on_click(cx.listener(move |_, _, _, cx| {
                    cx.emit(ChatEvent::OpenThread {
                        thread_id: thread_id.clone(),
                        environment_id: environment_id.clone(),
                    });
                }))
                .child(header)
                .child(body),
            (None, _) => card
                .a11y_group(format!("chat.subagent.{id}"), a11y_label)
                .child(header)
                .child(body),
        };

        #[cfg(test)]
        let card = {
            use gpui_kit::TestSupportExt as _;
            card.test_support()
        };
        div()
            .w_full()
            .min_w_0()
            .pb(px(8.0))
            .child(card)
            .into_any_element()
    }

    // -----------------------------------------------------------------------------------------
    // Changed files
    // -----------------------------------------------------------------------------------------

    pub(super) fn render_changed_files_card(
        &self,
        cp: &TurnCheckpointSummary,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let run_id = cp.run_id.clone();
        let all_expanded = self.changed_files_expanded.contains(&run_id);
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground);
        let hover_bg = hsla(self.tokens.shell_highlight);
        let added = hsla(self.tokens.diff_added);
        let removed = hsla(self.tokens.diff_removed);
        let surface = hsla(super::color::changed_files_surface(&self.tokens));
        let panel = super::color::changed_files_panel(&self.tokens);
        let label = if cp.file_count == 1 {
            "1 changed file".to_owned()
        } else {
            format!("{} changed files", cp.file_count)
        };
        let has_dirs = cp.files.iter().any(|f| f.path.contains(['/', '\\']));
        let first_path = cp.files.first().map(|f| f.path.clone());
        let ordinal = cp.app_run_ordinal;

        let stat = |additions: i64, deletions: i64| {
            div()
                .flex()
                .flex_row()
                .flex_none()
                .gap(px(6.0))
                .text_size(px(UI_FONT_PX))
                .line_height(px(18.0))
                .child(div().text_color(added).child(format!("+{additions}")))
                .child(div().text_color(removed).child(format!("-{deletions}")))
        };

        let mut header_left = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .gap_x(px(12.0))
            .min_w_0()
            .text_size(px(UI_FONT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .font_weight(FontWeight::MEDIUM)
            .text_color(fg)
            .child(label.clone());
        if cp.additions != 0 || cp.deletions != 0 {
            header_left = header_left.child(stat(cp.additions, cp.deletions));
        }
        let mut header_right = div().flex().flex_row().items_center().gap(px(4.0));
        if has_dirs {
            let toggle_run = run_id.clone();
            let tip = if all_expanded {
                "Collapse all folders"
            } else {
                "Expand all folders"
            };
            header_right = header_right.child(
                div()
                    .id(SharedString::from(format!("cf-toggle-all-{run_id}")))
                    .a11y_button(
                        SharedString::from(format!("chat.changed-files.toggle.{run_id}")),
                        tip,
                    )
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(24.0))
                    .rounded(px(6.0))
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover_bg))
                    .on_click(cx.listener(move |view, _, _, cx| {
                        if !view.changed_files_expanded.remove(&toggle_run) {
                            view.changed_files_expanded.insert(toggle_run.clone());
                        }
                        view.changed_files_dir_overrides.remove(&toggle_run);
                        view.remeasure_for_id(&format!("changed-files:{toggle_run}"));
                        cx.notify();
                    }))
                    .conn_tooltip(tip, &self.tokens)
                    .child(icons::icon(
                        if all_expanded {
                            icons::CHEVRONS_DOWN_UP
                        } else {
                            icons::CHEVRONS_UP_DOWN
                        },
                        14.0,
                        muted,
                    )),
            );
        }
        let open_run = run_id.clone();
        let open_path = first_path.clone();
        header_right = header_right.child(
            div()
                .id(SharedString::from(format!("cf-open-diff-{run_id}")))
                .a11y_button(
                    SharedString::from(format!("chat.changed-files.{run_id}")),
                    format!("Open diff · {label}"),
                )
                .flex()
                .items_center()
                .justify_center()
                .size(px(24.0))
                .rounded(px(6.0))
                .cursor_pointer()
                .hover(move |s| s.bg(hover_bg))
                .on_click(cx.listener(move |_, _, _, cx| {
                    cx.emit(ChatEvent::OpenTurnDiff {
                        run_id: open_run.clone(),
                        app_run_ordinal: ordinal,
                        file_path: open_path.clone(),
                    });
                }))
                .conn_tooltip("Open diff", &self.tokens)
                .child(icons::icon(icons::FILE_DIFF, 14.0, muted)),
        );

        let mut card = div()
            .id(SharedString::from(format!("changed-files-{run_id}")))
            .a11y_group(format!("chat.changed-files.group.{run_id}"), label)
            .flex()
            .flex_col()
            .w_full()
            .min_w_0()
            .gap(px(3.0))
            .p(px(3.0))
            .rounded(px(14.0))
            .bg(surface)
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .gap(px(8.0))
                    .min_h(px(30.0))
                    .pl(px(11.0))
                    .pr(px(5.0))
                    .child(header_left)
                    .child(header_right),
            );

        let tree = build_turn_diff_tree(&cp.files);
        let empty = HashMap::new();
        let overrides = self
            .changed_files_dir_overrides
            .get(&run_id)
            .unwrap_or(&empty);
        let rows = flatten_turn_diff_tree(&tree, overrides, all_expanded);
        let has_dir_nodes = tree.iter().any(|n| n.is_directory);
        let mut list = div()
            .flex()
            .flex_col()
            .p(px(3.0))
            .rounded(px(11.0))
            .bg(panel);
        for (row_idx, row) in rows.iter().enumerate() {
            let left = 8.0 + row.depth as f32 * TREE_INDENT_PX;
            let mut el = div()
                .id((SharedString::from(format!("cf-row-{run_id}")), row_idx))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(4.0))
                .h(px(28.0))
                .w_full()
                .min_w_0()
                .pl(px(left))
                .pr(px(8.0))
                .rounded(px(8.0))
                .cursor_pointer()
                .hover(move |s| s.bg(hover_bg))
                .text_size(px(UI_FONT_PX))
                .line_height(px(18.0));
            if row.is_directory {
                let dir_run = run_id.clone();
                let dir_path = row.path.clone();
                let currently = row.expanded;
                el = el
                    .a11y_button(
                        SharedString::from(format!("chat.changed-files.dir.{run_id}.{row_idx}")),
                        row.name.clone(),
                    )
                    .aria_expanded(row.expanded)
                    .on_click(cx.listener(move |view, _, _, cx| {
                        view.changed_files_dir_overrides
                            .entry(dir_run.clone())
                            .or_default()
                            .insert(dir_path.clone(), !currently);
                        view.remeasure_for_id(&format!("changed-files:{dir_run}"));
                        cx.notify();
                    }))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_center()
                            .size(px(16.0))
                            .flex_none()
                            .rounded(px(4.0))
                            .child(icons::icon(
                                if row.expanded {
                                    icons::CARET_DOWN
                                } else {
                                    icons::CARET_RIGHT
                                },
                                12.0,
                                muted,
                            )),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .text_color(hsla_alpha(self.tokens.muted_foreground, 0.9))
                            .child(row.name.clone()),
                    );
            } else {
                let file_run = run_id.clone();
                let file_path = row.path.clone();
                let file_icon = crate::file_icons::file_icon(&row.name);
                let icon_color = file_icon
                    .color
                    .map(|c| hsla(c.for_appearance(self.tokens.appearance)))
                    .unwrap_or_else(|| hsla_alpha(self.tokens.muted_foreground, 0.7));
                el = el
                    .a11y_button(
                        SharedString::from(format!("chat.changed-files.file.{run_id}.{row_idx}")),
                        row.path.clone(),
                    )
                    .on_click(cx.listener(move |_, _, _, cx| {
                        cx.emit(ChatEvent::OpenTurnDiff {
                            run_id: file_run.clone(),
                            app_run_ordinal: ordinal,
                            file_path: Some(file_path.clone()),
                        });
                    }))
                    .when(has_dir_nodes || row.depth > 0, |d| {
                        d.child(div().size(px(16.0)).flex_none())
                    })
                    .child(icons::icon(file_icon.asset, 14.0, icon_color))
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .text_color(hsla_alpha(self.tokens.foreground, 0.85))
                            .child(row.name.clone()),
                    );
            }
            if row.shows_stat() {
                el = el.child(div().ml_auto().child(stat(row.additions, row.deletions)));
            }
            list = list.child(el);
        }
        card = card.child(list);

        let hidden = cp.file_count.saturating_sub(cp.files.len());
        if hidden > 0 {
            let more_run = run_id.clone();
            let more_path = first_path;
            let more_label = if hidden == 1 {
                "1 more file in the full diff".to_owned()
            } else {
                format!("{hidden} more files in the full diff")
            };
            card = card.child(
                div().px(px(12.0)).pb(px(8.0)).child(
                    div()
                        .id(SharedString::from(format!("cf-more-{run_id}")))
                        .a11y_button(
                            format!("chat.changed-files.{run_id}.more"),
                            more_label.clone(),
                        )
                        .flex()
                        .items_center()
                        .h(px(24.0))
                        .px(px(8.0))
                        .rounded(px(6.0))
                        .cursor_pointer()
                        .text_size(px(UI_FONT_PX))
                        .text_color(muted)
                        .hover(move |s| s.bg(hover_bg).text_color(fg))
                        .on_click(cx.listener(move |_, _, _, cx| {
                            cx.emit(ChatEvent::OpenTurnDiff {
                                run_id: more_run.clone(),
                                app_run_ordinal: ordinal,
                                file_path: more_path.clone(),
                            });
                        }))
                        .child(more_label),
                ),
            );
        }

        div()
            .pt(px(16.0))
            .pb(px(4.0))
            .child(card)
            .into_any_element()
    }

    // -----------------------------------------------------------------------------------------
    // Lazy tool detail
    // -----------------------------------------------------------------------------------------

    /// Fetches a tool row's omitted output once (`orchestration.getTurnItem`).
    pub(super) fn fetch_omitted_detail(&mut self, entry_id: &str, cx: &mut Context<'_, Self>) {
        if self.fetched_details.contains_key(entry_id) {
            return;
        }
        let (Some(connection), Some(thread_id)) = (self.connection.clone(), self.thread_id.clone())
        else {
            return;
        };
        self.fetched_details
            .insert(entry_id.to_owned(), DetailFetch::Loading);
        let entry_id = entry_id.to_owned();
        cx.spawn(async move |this, cx| {
            let result = connection.get_turn_item(&thread_id, &entry_id, None).await;
            let _ = this.update(cx, |view, cx| {
                let state = match result {
                    Ok(item) => DetailFetch::Loaded(item.and_then(conn_state::turn_item_detail)),
                    Err(err) => DetailFetch::Failed(crate::commands::format_client_error(&err)),
                };
                view.fetched_details.insert(entry_id.clone(), state);
                view.remeasure_for_id(&entry_id);
                cx.notify();
            });
        })
        .detach();
    }

    // -----------------------------------------------------------------------------------------
    // Small building blocks
    // -----------------------------------------------------------------------------------------

    /// Conn `WorkLogRow`: 24px icon box + `text-sm` label, optional caret.
    fn work_log_line(
        &self,
        key: &str,
        icon: &'static str,
        label: &str,
        has_body: bool,
        expanded: bool,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        let fg = hsla(self.tokens.foreground);
        let mut line = div()
            .id(SharedString::from(format!("log-{key}")))
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
                    .child(icons::icon(icon, 14.0, muted_icon(&self.tokens))),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .child(label.to_owned()),
            );
        if has_body {
            line = line
                .cursor_pointer()
                .hover(move |s| s.text_color(fg))
                .child(icons::icon(
                    if expanded {
                        icons::CARET_DOWN
                    } else {
                        icons::CARET_RIGHT
                    },
                    12.0,
                    muted_icon(&self.tokens),
                ));
        }
        line
    }

    /// Conn `Button variant="ghost-muted" size="xs"`.
    pub(super) fn ghost_button(
        &self,
        key: &str,
        label: &str,
        enabled: bool,
        _cx: &mut Context<'_, Self>,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        let fg = hsla(self.tokens.foreground);
        let hover_bg = hsla(self.tokens.shell_highlight);
        div()
            .id(SharedString::from(key.to_owned()))
            .a11y_button(SharedString::from(format!("chat.{key}")), label.to_owned())
            .flex()
            .flex_row()
            .flex_none()
            .items_center()
            .gap(px(4.0))
            .h(px(24.0))
            .px(px(8.0))
            .rounded(px(6.0))
            .text_size(px(UI_FONT_PX))
            .text_color(hsla(self.tokens.muted_foreground))
            .when(enabled, move |d| {
                d.cursor_pointer()
                    .hover(move |s| s.bg(hover_bg).text_color(fg))
            })
            .when(!enabled, |d| d.opacity(0.5))
            .child(label.to_owned())
    }

    /// Conn `Button variant="outline" size="sm"`.
    pub(super) fn outline_button(
        &self,
        key: &str,
        label: &str,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        outline_button_surface(
            &self.tokens,
            SharedString::from(key.to_owned()),
            SharedString::from(format!("chat.{key}")),
            label.to_owned(),
        )
        .h(px(32.0))
        .px(px(12.0))
        .rounded(px(8.0))
        .text_size(px(UI_FONT_PX))
        .child(label.to_owned())
    }
}

/// A quiet text button of the question card (`TextAction`): `text-sm font-medium`, muted until
/// hovered. The last action ends in line with the question text, not at the pill edge.
pub(super) fn question_text_action(
    tokens: &conn_theme::Tokens,
    key: String,
    ax_id: String,
    ax_label: &'static str,
    text: &'static str,
    enabled: bool,
    last: bool,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let fg = hsla(tokens.foreground);
    div()
        .id(SharedString::from(key))
        .a11y_button(SharedString::from(ax_id), ax_label)
        .flex_none()
        .text_size(px(BODY_FONT_PX))
        .line_height(px(20.0))
        .font_weight(FontWeight::MEDIUM)
        .text_color(hsla(tokens.muted_foreground))
        .when(last, |d| d.mr(px(12.0)))
        .when(enabled, move |d| {
            d.cursor_pointer().hover(move |s| s.text_color(fg))
        })
        .when(!enabled, |d| d.opacity(0.5))
        .child(text)
}

/// Colors and behavior of Conn `Button variant="outline"`: `border-input`, `bg-popover`
/// (`dark:bg-input/32`), hover `bg-accent/50` (`dark:bg-input/64`). Callers add size and content.
pub(super) fn outline_button_surface(
    tokens: &conn_theme::Tokens,
    id: SharedString,
    ax_id: SharedString,
    label: String,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let dark = tokens.appearance == Appearance::Dark;
    let (bg, hover_bg) = if dark {
        (
            hsla_alpha(tokens.input, tokens.input.a * 0.32),
            hsla_alpha(tokens.input, tokens.input.a * 0.64),
        )
    } else {
        (hsla(tokens.popover), hsla_alpha(tokens.accent, 0.5))
    };
    div()
        .id(id)
        .a11y_button(ax_id, label)
        .flex()
        .flex_row()
        .items_center()
        .justify_center()
        .border_1()
        .border_color(hsla(tokens.input))
        .bg(bg)
        .cursor_pointer()
        .font_weight(FontWeight::MEDIUM)
        .text_color(hsla(tokens.foreground))
        .hover(move |s| s.bg(hover_bg))
}

/// `<model> · <effort>` for a subagent card, for example `Opus 5.5 · medium`. The model name is the
/// composer's trigger label; the effort is the composer's effort label, lowercased. A model the
/// catalog does not list shows its slug and the raw reasoning option.
fn subagent_model_text(
    catalog: &conn_state::providers::ModelCatalog,
    model: &conn_state::SubagentModel,
) -> Option<String> {
    let slug = model.model.as_deref()?;
    let found = catalog.find_model(model.instance_id.as_deref(), slug);
    let name = found.map_or_else(
        || slug.to_owned(),
        conn_state::providers::ModelOption::trigger_label,
    );
    let options: conn_state::providers::OptionMap = model
        .options
        .iter()
        .map(|(id, value)| {
            let value = match value.as_str() {
                "true" => serde_json::Value::Bool(true),
                "false" => serde_json::Value::Bool(false),
                other => serde_json::Value::String(other.to_owned()),
            };
            (id.clone(), value)
        })
        .collect();
    let effort = found
        .and_then(|found| found.effort_summary(Some(&options)).word)
        .or_else(|| {
            ["reasoningEffort", "effort", "reasoning"]
                .iter()
                .find_map(|key| model.options.get(*key).cloned())
        })
        .map(|word| word.to_lowercase());
    Some(match effort {
        Some(effort) if !effort.is_empty() => format!("{name} · {effort}"),
        _ => name,
    })
}

#[cfg(test)]
mod subagent_model_tests {
    use super::subagent_model_text;
    use conn_state::SubagentModel;
    use conn_state::providers::ModelCatalog;
    use std::collections::HashMap;

    #[test]
    fn a_model_the_catalog_lacks_shows_its_slug_and_raw_effort() {
        let catalog = ModelCatalog::default();
        let model = SubagentModel {
            model: Some("claude-opus-5-5".to_owned()),
            instance_id: Some("claudeAgent".to_owned()),
            options: HashMap::from([("reasoningEffort".to_owned(), "Medium".to_owned())]),
        };
        assert_eq!(
            subagent_model_text(&catalog, &model).as_deref(),
            Some("claude-opus-5-5 · medium")
        );
        let bare = SubagentModel {
            options: HashMap::new(),
            ..model
        };
        assert_eq!(
            subagent_model_text(&catalog, &bare).as_deref(),
            Some("claude-opus-5-5")
        );
        assert_eq!(
            subagent_model_text(&catalog, &SubagentModel::default()),
            None
        );
    }
}
