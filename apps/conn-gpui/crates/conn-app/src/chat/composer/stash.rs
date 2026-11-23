//! Prompt stash (`ComposerStashBadge.tsx`, `ComposerStashMenu.tsx`, `useComposerStash.ts`,
//! `promptStashStore.ts` parity).
//!
//! `⌘S` moves the draft into the stash (newest first, capped at [`MAX_STASH_ENTRIES`]); with an
//! empty draft it toggles the stash drawer. The shoulder badge (`BookmarkIcon` + `Stash` + count)
//! sits on the composer's top edge whenever the stash holds entries.

use std::time::{SystemTime, UNIX_EPOCH};

use conn_contract::ChatAttachment;
use conn_theme::Tokens;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, Context, FontWeight, InteractiveElement as _, IntoElement, MouseButton,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _, div, px,
};

use super::super::color::{hsla, hsla_alpha};
use super::super::icons;
use super::Composer;
use crate::a11y::ConnA11yExt as _;
use crate::panels::chrome::ConnTooltipExt as _;

/// `MAX_STASH_ENTRIES` in `promptStashStore.ts`.
pub(crate) const MAX_STASH_ENTRIES: usize = 20;
/// `SNIPPET_MAX_CHARS` in `ComposerStashMenu.tsx`.
const SNIPPET_MAX_CHARS: usize = 90;
/// Stash shortcut label (`composer.stash`, `Mod+S`).
pub(crate) const STASH_SHORTCUT_LABEL: &str = "⌘S";

const ICON_BOOKMARK: &str = "superhero/bookmark.svg";
const ICON_FILE_TEXT: &str = "superhero/file-text.svg";
const ICON_FILE: &str = "superhero/file.svg";

/// One stashed draft.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct StashEntry {
    pub(crate) id: u64,
    pub(crate) prompt: String,
    /// Uploaded attachments carried with the draft.
    pub(crate) attachments: Vec<ChatAttachment>,
    /// Unix milliseconds when stashed.
    pub(crate) created_at_ms: i64,
}

impl StashEntry {
    /// `stashEntrySnippet`: collapsed whitespace, 90 chars + `…`, or an attachment count.
    #[must_use]
    pub(crate) fn snippet(&self) -> String {
        let collapsed = self.prompt.split_whitespace().collect::<Vec<_>>().join(" ");
        if !collapsed.is_empty() {
            let count = collapsed.chars().count();
            if count > SNIPPET_MAX_CHARS {
                let cut: String = collapsed.chars().take(SNIPPET_MAX_CHARS).collect();
                return format!("{cut}…");
            }
            return collapsed;
        }
        let images = self
            .attachments
            .iter()
            .filter(|a| matches!(a, ChatAttachment::Image(_)))
            .count();
        let files = self.attachments.len() - images;
        let total = images + files;
        if total == 0 {
            return "(empty)".to_owned();
        }
        let label = if images > 0 && files > 0 {
            "attachment"
        } else if files > 0 {
            "file"
        } else {
            "image"
        };
        format!("({total} {label}{})", if total == 1 { "" } else { "s" })
    }
}

/// The stash queue plus its drawer state.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct PromptStash {
    entries: Vec<StashEntry>,
    next_id: u64,
    /// Bumped on every stash; Conn replays the badge pulse per key.
    pub(crate) pulse_key: u64,
    pub(crate) menu_open: bool,
    pub(crate) highlighted: usize,
}

impl PromptStash {
    /// Entries, newest first.
    #[must_use]
    pub(crate) fn entries(&self) -> &[StashEntry] {
        &self.entries
    }

    /// Pushes a draft to the front. Returns the evicted oldest entry when the stash was full.
    pub(crate) fn push(
        &mut self,
        prompt: String,
        attachments: Vec<ChatAttachment>,
        now_ms: i64,
    ) -> Option<StashEntry> {
        self.next_id = self.next_id.wrapping_add(1);
        self.entries.insert(
            0,
            StashEntry {
                id: self.next_id,
                prompt,
                attachments,
                created_at_ms: now_ms,
            },
        );
        self.pulse_key = self.pulse_key.wrapping_add(1);
        self.highlighted = 0;
        if self.entries.len() > MAX_STASH_ENTRIES {
            self.entries.pop()
        } else {
            None
        }
    }

    /// Removes and returns the entry with `id`.
    pub(crate) fn take(&mut self, id: u64) -> Option<StashEntry> {
        let index = self.entries.iter().position(|e| e.id == id)?;
        let entry = self.entries.remove(index);
        self.clamp_highlight();
        Some(entry)
    }

    /// Deletes the entry with `id`.
    pub(crate) fn delete(&mut self, id: u64) {
        self.entries.retain(|e| e.id != id);
        self.clamp_highlight();
    }

    /// Moves the highlight by `delta`, wrapping (`ArrowUp` / `ArrowDown`).
    pub(crate) fn move_highlight(&mut self, delta: isize) {
        let len = self.entries.len();
        if len == 0 {
            return;
        }
        let len_i = isize::try_from(len).unwrap_or(isize::MAX);
        let current = isize::try_from(self.highlighted).unwrap_or(0);
        self.highlighted = usize::try_from((current + delta).rem_euclid(len_i)).unwrap_or(0);
    }

    /// The highlighted entry's id.
    #[must_use]
    pub(crate) fn highlighted_id(&self) -> Option<u64> {
        self.entries.get(self.highlighted).map(|e| e.id)
    }

    fn clamp_highlight(&mut self) {
        if self.highlighted >= self.entries.len() {
            self.highlighted = self.entries.len().saturating_sub(1);
        }
    }
}

/// Unix milliseconds now.
#[must_use]
pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// Compact relative time (`RelativeTime`): `now`, `5m`, `3h`, `2d`.
#[must_use]
pub(crate) fn relative_time(created_at_ms: i64, now_ms: i64) -> String {
    let seconds = (now_ms - created_at_ms).max(0) / 1_000;
    if seconds < 60 {
        "now".to_owned()
    } else if seconds < 3_600 {
        format!("{}m", seconds / 60)
    } else if seconds < 86_400 {
        format!("{}h", seconds / 3_600)
    } else {
        format!("{}d", seconds / 86_400)
    }
}

/// `ComposerStashBadge`: the right-aligned shoulder tab above the composer card.
pub(super) fn render_stash_badge(
    stash: &PromptStash,
    tokens: &Tokens,
    cx: &mut Context<'_, Composer>,
) -> Option<AnyElement> {
    let tab = render_stash_badge_tab(stash, tokens, cx)?;
    Some(
        div()
            .flex()
            .flex_row()
            .justify_end()
            .w_full()
            .px(px(22.0))
            .child(tab)
            .into_any_element(),
    )
}

/// The badge's tab alone, for a host dock that places it beside its own banner.
pub(super) fn render_stash_badge_tab(
    stash: &PromptStash,
    tokens: &Tokens,
    cx: &mut Context<'_, Composer>,
) -> Option<AnyElement> {
    let count = stash.entries().len();
    if count == 0 {
        return None;
    }
    let fg = hsla(tokens.foreground);
    let muted = hsla(tokens.muted_foreground);
    let open = stash.menu_open;
    let (bg, border) = banner_colors(tokens);
    Some(
        div()
            .id(SharedString::from(format!(
                "composer-stash-badge-{}",
                stash.pulse_key % 2
            )))
            .a11y_button(
                "composer.stash-badge",
                format!("Stashed prompts: {count}. Open stash."),
            )
            .aria_expanded(open)
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .h(px(28.0))
            .px(px(10.0))
            .mb(px(-1.0))
            .rounded_t(px(10.0))
            .bg(bg)
            .border_1()
            .border_b_0()
            .border_color(border)
            .cursor_pointer()
            .text_size(px(12.0))
            .line_height(px(16.0))
            .text_color(if open { fg } else { muted })
            .hover(move |s| s.text_color(fg))
            .on_click(cx.listener(|composer, _, _, cx| {
                composer.toggle_stash_menu(cx);
            }))
            .conn_tooltip(format!("Stash ({STASH_SHORTCUT_LABEL})"), tokens)
            .child(icons::icon(
                ICON_BOOKMARK,
                14.0,
                if open { fg } else { muted },
            ))
            .child("Stash")
            .child(div().text_color(muted).child(count.to_string()))
            .into_any_element(),
    )
}

/// `ComposerStashMenu`: the attached drawer listing stashed drafts.
pub(super) fn render_stash_menu(
    stash: &PromptStash,
    tokens: &Tokens,
    cx: &mut Context<'_, Composer>,
) -> AnyElement {
    let fg = hsla(tokens.foreground);
    let muted = hsla(tokens.muted_foreground);
    let highlight_bg = hsla(tokens.accent);
    let (bg, border) = banner_colors(tokens);
    let now = now_ms();

    let header = div()
        .id("composer-stash-header")
        .a11y_button("composer.stash-close", "Close stash")
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .h(px(32.0))
        .px(px(10.0))
        .cursor_pointer()
        .on_click(cx.listener(|composer, _, _, cx| {
            composer.close_stash_menu(cx);
        }))
        .child(icons::icon(ICON_BOOKMARK, 14.0, muted))
        .child(div().flex_1().text_color(muted).child("Stash"))
        .child(
            div()
                .text_color(muted)
                .child(stash.entries().len().to_string()),
        )
        .child(icons::icon(icons::CARET_DOWN, 12.0, muted));

    let mut list = div()
        .id("composer-stash-list")
        .flex()
        .flex_col()
        .gap(px(2.0))
        .px(px(4.0))
        .pb(px(4.0))
        .max_h(px(240.0))
        .overflow_y_scroll();

    if stash.entries().is_empty() {
        list = list.child(
            div()
                .px(px(30.0))
                .py(px(6.0))
                .text_color(muted)
                .child(format!(
                    "Nothing stashed yet. Press {STASH_SHORTCUT_LABEL} with a prompt in the composer to stash it."
                )),
        );
    }
    for (index, entry) in stash.entries().iter().enumerate() {
        let id = entry.id;
        let highlighted = index == stash.highlighted;
        let snippet = entry.snippet();
        let files = entry
            .attachments
            .iter()
            .filter(|a| !matches!(a, ChatAttachment::Image(_)))
            .count();
        let images = entry.attachments.len() - files;
        let mut actions = div()
            .flex()
            .flex_row()
            .flex_none()
            .items_center()
            .gap(px(8.0))
            .text_color(muted);
        if images > 0 {
            actions = actions.child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(4.0))
                    .child(icons::icon(icons::IMAGE, 12.0, muted))
                    .child(images.to_string()),
            );
        }
        if files > 0 {
            actions = actions.child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(4.0))
                    .child(icons::icon(ICON_FILE, 12.0, muted))
                    .child(files.to_string()),
            );
        }
        let dismiss_hover = hsla(tokens.shell_highlight);
        actions = actions
            .child(relative_time(entry.created_at_ms, now))
            .child(
                div()
                    .id(SharedString::from(format!("composer-stash-delete-{id}")))
                    .a11y_button("composer.stash-delete", "Delete stashed prompt")
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(18.0))
                    .rounded(px(4.0))
                    .cursor_pointer()
                    .hover(move |s| s.bg(dismiss_hover))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |composer, _, _, cx| {
                        cx.stop_propagation();
                        composer.delete_stash_entry(id, cx);
                    }))
                    .child(icons::icon(icons::CLOSE, 11.0, muted)),
            );
        list = list.child(
            div()
                .id(SharedString::from(format!("composer-stash-entry-{id}")))
                .a11y_button(
                    "composer.stash-restore",
                    format!("Restore stashed prompt: {snippet}"),
                )
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.0))
                .h(px(30.0))
                .px(px(6.0))
                .rounded(px(4.0))
                .cursor_pointer()
                .when(highlighted, |el| el.bg(highlight_bg))
                .on_mouse_move(cx.listener(move |composer, _, _, cx| {
                    composer.highlight_stash_entry(index, cx);
                }))
                .on_click(cx.listener(move |composer, _, window, cx| {
                    composer.restore_stash_entry(id, window, cx);
                }))
                .child(icons::icon(ICON_FILE_TEXT, 14.0, muted))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_color(hsla_alpha(tokens.foreground, 0.80))
                        .child(snippet),
                )
                .child(actions),
        );
    }

    div()
        .id("composer-stash-drawer")
        .flex()
        .flex_col()
        .mx(px(22.0))
        .mb(px(-1.0))
        .rounded_t(px(12.0))
        .bg(bg)
        .border_1()
        .border_b_0()
        .border_color(border)
        .text_size(px(12.0))
        .line_height(px(16.0))
        .text_color(fg)
        .font_weight(FontWeight::NORMAL)
        .occlude()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(header)
        .child(list)
        .into_any_element()
}

/// `ComposerBanner.Root` default surface and border.
fn banner_colors(tokens: &Tokens) -> (gpui_kit::Hsla, gpui_kit::Hsla) {
    crate::chat::color::banner_surface(tokens)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snippet_collapses_whitespace_and_truncates() {
        let entry = StashEntry {
            id: 1,
            prompt: "  fix   the\nbuild  ".to_owned(),
            attachments: Vec::new(),
            created_at_ms: 0,
        };
        assert_eq!(entry.snippet(), "fix the build");
        let long = StashEntry {
            prompt: "x".repeat(120),
            ..entry.clone()
        };
        assert_eq!(long.snippet().chars().count(), SNIPPET_MAX_CHARS + 1);
        assert!(long.snippet().ends_with('…'));
        let empty = StashEntry {
            prompt: String::new(),
            ..entry
        };
        assert_eq!(empty.snippet(), "(empty)");
    }

    #[test]
    fn push_orders_newest_first_and_evicts_oldest() {
        let mut stash = PromptStash::default();
        for n in 0..MAX_STASH_ENTRIES {
            assert!(stash.push(format!("p{n}"), Vec::new(), 0).is_none());
        }
        assert_eq!(
            stash.entries()[0].prompt,
            format!("p{}", MAX_STASH_ENTRIES - 1)
        );
        let evicted = stash.push("newest".to_owned(), Vec::new(), 0);
        assert_eq!(evicted.map(|e| e.prompt).as_deref(), Some("p0"));
        assert_eq!(stash.entries().len(), MAX_STASH_ENTRIES);
        assert_eq!(stash.pulse_key, (MAX_STASH_ENTRIES + 1) as u64);
    }

    #[test]
    fn take_delete_and_highlight_wrap() {
        let mut stash = PromptStash::default();
        stash.push("a".to_owned(), Vec::new(), 0);
        stash.push("b".to_owned(), Vec::new(), 0);
        stash.push("c".to_owned(), Vec::new(), 0);
        stash.move_highlight(-1);
        assert_eq!(stash.highlighted, 2, "wraps to last");
        let last = stash.highlighted_id().expect("highlighted entry");
        assert_eq!(stash.take(last).map(|e| e.prompt).as_deref(), Some("a"));
        assert_eq!(stash.highlighted, 1, "clamps after removal");
        let first = stash.entries()[0].id;
        stash.delete(first);
        assert_eq!(stash.entries().len(), 1);
        assert_eq!(stash.entries()[0].prompt, "b");
    }

    #[test]
    fn relative_time_buckets() {
        assert_eq!(relative_time(0, 30_000), "now");
        assert_eq!(relative_time(0, 5 * 60_000), "5m");
        assert_eq!(relative_time(0, 3 * 3_600_000), "3h");
        assert_eq!(relative_time(0, 2 * 86_400_000), "2d");
    }
}
