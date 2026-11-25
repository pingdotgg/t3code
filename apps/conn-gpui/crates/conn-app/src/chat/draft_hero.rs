//! The new-thread composer and its draft content.

use super::color::hsla;
use super::composer_state::{
    draft_id_from_key, new_thread_draft_key, thread_draft_key, thread_id_from_key,
};
use super::{CHAT_CONTENT_MAX_WIDTH_PX, CHAT_LANE_PADDING_X_PX, ChatView};
use crate::a11y::ConnA11yExt as _;
use crate::drafts::DraftContent;
use gpui_kit::TestSupportExt as _;
use gpui_kit::{
    AnyElement, Context, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _,
    Styled as _, div, px,
};

impl ChatView {
    /// Calls `visit(draft id, text, attachment count)` for every new-thread draft the composer
    /// holds, the shown one included.
    pub(crate) fn visit_drafts(
        &self,
        cx: &gpui_kit::App,
        mut visit: impl FnMut(&str, &str, usize),
    ) {
        self.composer.read(cx).visit_drafts(cx, |key, text, count| {
            if let Some(draft_id) = draft_id_from_key(key) {
                visit(draft_id, text, count);
            }
        });
    }

    /// Calls `visit(thread id, text, attachment count)` for every started thread's composer
    /// that the store holds, the shown one included.
    pub(crate) fn visit_thread_drafts(
        &self,
        cx: &gpui_kit::App,
        mut visit: impl FnMut(&str, &str, usize),
    ) {
        self.composer.read(cx).visit_drafts(cx, |key, text, count| {
            if let Some(thread_id) = thread_id_from_key(key) {
                visit(thread_id, text, count);
            }
        });
    }

    /// What each started thread's composer holds that outlives a restart, by thread id.
    pub(crate) fn saved_thread_drafts(&self, cx: &gpui_kit::App) -> Vec<(String, DraftContent)> {
        self.composer
            .read(cx)
            .saved_drafts(cx)
            .into_iter()
            .filter_map(|(key, content)| Some((thread_id_from_key(&key)?.to_owned(), content)))
            .collect()
    }

    /// Puts a started thread's unsent text and attachments back (read from disk, or an undone
    /// discard).
    pub(crate) fn restore_thread_draft(
        &mut self,
        thread_id: &str,
        content: DraftContent,
        cx: &mut Context<'_, Self>,
    ) {
        let key = thread_draft_key(thread_id);
        self.composer
            .update(cx, |c, _| c.restore_draft(&key, content));
    }

    /// Clears a started thread's unsent input (`discardComposerDraft` on a thread target) and
    /// returns what it held, for an undo.
    pub(crate) fn discard_thread_draft(
        &mut self,
        thread_id: &str,
        cx: &mut Context<'_, Self>,
    ) -> Option<DraftContent> {
        let key = thread_draft_key(thread_id);
        self.composer
            .update(cx, |c, cx| c.discard_draft_key(&key, cx))
    }

    /// The model picker is open.
    pub(crate) fn model_picker_open(&self, cx: &gpui_kit::App) -> bool {
        self.composer.read(cx).model_picker_is_open()
    }

    /// Drops a started thread's unsent input for good, as its deletion does
    /// (`clearComposerDraftForThread`).
    pub(crate) fn forget_thread_draft(&mut self, thread_id: &str, cx: &mut Context<'_, Self>) {
        let key = thread_draft_key(thread_id);
        self.composer.update(cx, |c, cx| {
            c.discard_draft_key(&key, cx);
        });
    }

    /// What each new-thread draft holds that outlives a restart, by draft id.
    pub(crate) fn saved_drafts(&self, cx: &gpui_kit::App) -> Vec<(String, DraftContent)> {
        self.composer
            .read(cx)
            .saved_drafts(cx)
            .into_iter()
            .filter_map(|(key, content)| Some((draft_id_from_key(&key)?.to_owned(), content)))
            .collect()
    }

    /// Puts a draft's text and attachments back (read from disk, or an undone discard).
    pub(crate) fn restore_draft(
        &mut self,
        draft_id: &str,
        content: DraftContent,
        cx: &mut Context<'_, Self>,
    ) {
        let key = new_thread_draft_key(draft_id);
        self.composer
            .update(cx, |c, _| c.restore_draft(&key, content));
    }

    /// Clears a draft once it is sent or discarded (`clearDraftThread`) and returns what it
    /// held, for an undo.
    pub(crate) fn discard_draft(
        &mut self,
        draft_id: &str,
        cx: &mut Context<'_, Self>,
    ) -> Option<DraftContent> {
        let key = new_thread_draft_key(draft_id);
        self.composer
            .update(cx, |c, cx| c.discard_draft_key(&key, cx))
    }

    /// Full chat-card layout while composing a draft: headline above, composer centered,
    /// notices detached below so they never move the centered card.
    pub(super) fn render_draft_hero(&mut self, cx: &mut Context<'_, Self>) -> AnyElement {
        let lane = || {
            div()
                .w_full()
                .max_w(px(CHAT_CONTENT_MAX_WIDTH_PX))
                .mx_auto()
        };
        let heading = "What should we work on?";
        let headline = div()
            .id("draft-heading")
            .test_support()
            .a11y(gpui_kit::Role::Heading, "chat.draft.heading", heading)
            .text_center()
            .text_size(px(30.0))
            .line_height(px(36.0))
            .font_weight(FontWeight::NORMAL)
            .text_color(hsla(self.tokens.foreground))
            .child(heading);
        let mut below = lane().flex().flex_col().gap(px(4.0)).pt(px(16.0));
        if let Some(error) = self.error_banner.clone() {
            below = below.child(self.render_error_banner(&error, cx));
        }

        div()
            .id("chat-draft-hero")
            .test_support()
            .a11y_group("chat.draft-hero", "New thread")
            .flex()
            .flex_col()
            .size_full()
            .min_h_0()
            .min_w_0()
            .px(px(CHAT_LANE_PADDING_X_PX))
            .child(
                div()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .justify_end()
                    .child(lane().pb(px(16.0)).child(headline)),
            )
            .child(lane().flex_none().child(self.composer.clone()))
            .child(div().flex_1().flex().flex_col().child(below))
            .into_any_element()
    }
}
