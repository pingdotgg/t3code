//! The keyboard behaviour of the thread sidebar, as Conn has it: arrow keys between rows
//! (`lib/sidebarTree.ts`), arrow keys in the thread and draft menus (`contextMenuFallback.ts`),
//! and `⌘Z` for discarded drafts (`hooks/showThreadUndoNotice.ts`, `lib/discardComposerDraft.ts`).
//! What each key does comes from `conn_state::sidebar_nav` and `conn_state::discard_undo`; this
//! file applies it to the app.

use conn_state::{
    DISCARD_UNDO_SECS, KeyMods, MenuKey, MenuNavItem, MenuStep, RowKey, RowKind, TreeStep,
    UNDO_FAILED_NEW_CONTENT, UndoShortcutScene, draft_has_content, first_enabled, is_modifier_key,
    is_undo_key, menu_key, menu_step, row_key, row_kind, tree_key, tree_step,
    undo_shortcut_applies,
};
use gpui_kit::{Context, KeyDownEvent, KeystrokeEvent, Modifiers, Window};

use super::{ConnApp, DiscardedDraft};
use crate::sidebar::thread_list::SETTLED_SHELF_TOGGLE_KEY;
use crate::sidebar::thread_menu::{MenuCursor, ThreadMenuItem};

fn key_mods(modifiers: &Modifiers) -> KeyMods {
    KeyMods {
        shift: modifiers.shift,
        alt: modifiers.alt,
        control: modifiers.control,
        platform: modifiers.platform,
    }
}

fn nav_items(items: &[ThreadMenuItem]) -> Vec<MenuNavItem> {
    items
        .iter()
        .map(|item| MenuNavItem {
            enabled: !item.disabled,
            submenu: !item.children.is_empty(),
        })
        .collect()
}

impl ConnApp {
    /// A key pressed on the sidebar row `row` (`thread id`, `draft:<id>` or `shelf:settled`).
    /// Arrow keys, `Home` and `End` move the keyboard between rows without opening them;
    /// `Enter` / `Space` open the row, `F2` renames a thread, and `ContextMenu` / `Shift+F10`
    /// open its menu below it. Keys on a button inside the row belong to the button.
    pub(crate) fn sidebar_row_key(
        &mut self,
        row: &str,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if !self.sidebar_tree.is_focused(row, window) {
            return;
        }
        let keystroke = &event.keystroke;
        let mods = key_mods(&keystroke.modifiers);
        let kind = row_kind(row);
        if let Some(key) = row_key(kind, &keystroke.key, mods) {
            cx.stop_propagation();
            self.run_row_key(row, kind, key, window, cx);
        } else if let Some(key) = tree_key(&keystroke.key, mods) {
            cx.stop_propagation();
            match tree_step(self.sidebar_tree.rows(), row, key) {
                Some(TreeStep::Focus(target)) => {
                    self.sidebar_tree.focus(&target, window, cx);
                    cx.notify();
                }
                Some(TreeStep::Toggle(_)) => {
                    self.toggle_project_collapsed(SETTLED_SHELF_TOGGLE_KEY, cx)
                }
                Some(TreeStep::Stay) | None => {}
            }
        }
    }

    fn run_row_key(
        &mut self,
        row: &str,
        kind: RowKind<'_>,
        key: RowKey,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        match (kind, key) {
            (RowKind::Draft(id), RowKey::Activate) => self.open_draft(id, Some(window), cx),
            (RowKind::Thread(id), RowKey::Activate) => {
                self.select_thread(id.to_owned(), cx);
                self.chat
                    .update(cx, |chat, cx| chat.focus_composer(window, cx));
            }
            (RowKind::Shelf(_), RowKey::Activate) => {
                self.toggle_project_collapsed(SETTLED_SHELF_TOGGLE_KEY, cx);
            }
            (RowKind::Thread(id), RowKey::Rename) => {
                let title = self.shell.find_thread(id).map(|t| t.title.clone());
                if let Some(title) = title
                    && self.renaming_thread_id.as_deref() != Some(id)
                {
                    self.start_thread_rename(id.to_owned(), title, window, cx);
                }
            }
            (RowKind::Thread(id), RowKey::Menu) => {
                if let Some(position) = self.sidebar_tree.below(row) {
                    self.open_thread_menu(id.to_owned(), position, cx);
                    self.highlight_first_menu_row();
                }
            }
            (RowKind::Draft(id), RowKey::Menu) => {
                if let Some(position) = self.sidebar_tree.below(row) {
                    self.open_draft_menu(id.to_owned(), position, cx);
                    self.highlight_first_menu_row();
                }
            }
            _ => {}
        }
    }

    /// A menu opened from the keyboard starts on its first action; one opened with the pointer
    /// starts on none.
    fn highlight_first_menu_row(&mut self) {
        let Some(anchor) = &self.thread_menu else {
            return;
        };
        let Some(items) = self.thread_menu_items(anchor) else {
            return;
        };
        let first = first_enabled(&nav_items(&items));
        if let Some(menu) = &mut self.thread_menu {
            menu.cursor = MenuCursor {
                root: first,
                ..MenuCursor::default()
            };
        }
    }

    /// The pointer is over row `idx` of a menu level: the keyboard highlight follows it, so the
    /// menu has one highlighted row (`mouseenter` focuses the row).
    pub(crate) fn highlight_thread_menu_row(
        &mut self,
        in_submenu: bool,
        idx: usize,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(menu) = &mut self.thread_menu else {
            return;
        };
        let before = menu.cursor;
        if in_submenu {
            menu.cursor.sub = Some(idx);
            menu.cursor.in_sub = true;
        } else {
            menu.cursor.root = Some(idx);
            menu.cursor.in_sub = false;
        }
        if menu.cursor != before {
            cx.notify();
        }
    }

    /// A key inside the open thread or draft menu. Returns whether the menu used it.
    fn thread_menu_key(
        &mut self,
        key: MenuKey,
        backwards: bool,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> bool {
        let Some(anchor) = self.thread_menu.clone() else {
            return false;
        };
        let Some(items) = self.thread_menu_items(&anchor) else {
            return false;
        };
        let parent = items.iter().position(|item| !item.children.is_empty());
        let in_sub = anchor.cursor.in_sub && anchor.copy_open && parent.is_some();
        let level: &[ThreadMenuItem] = match parent {
            Some(parent) if in_sub => &items[parent].children,
            _ => &items,
        };
        let highlighted = if in_sub {
            anchor.cursor.sub
        } else {
            anchor.cursor.root
        };
        match menu_step(&nav_items(level), highlighted, in_sub, key) {
            MenuStep::Highlight(index) => {
                self.thread_menu_copy_close_gen = self.thread_menu_copy_close_gen.wrapping_add(1);
                if let Some(menu) = &mut self.thread_menu {
                    if in_sub {
                        menu.cursor.sub = Some(index);
                    } else {
                        menu.cursor.root = Some(index);
                        menu.cursor.in_sub = false;
                        // A row other than the submenu's own closes it.
                        menu.copy_open &= Some(index) == parent;
                    }
                }
                cx.notify();
                true
            }
            MenuStep::OpenSubmenu(index) => {
                self.thread_menu_copy_close_gen = self.thread_menu_copy_close_gen.wrapping_add(1);
                let first = parent
                    .map(|parent| nav_items(&items[parent].children))
                    .and_then(|nav| first_enabled(&nav));
                if let Some(menu) = &mut self.thread_menu {
                    menu.copy_open = true;
                    menu.cursor = MenuCursor {
                        root: Some(index),
                        sub: first,
                        in_sub: true,
                    };
                }
                cx.notify();
                true
            }
            MenuStep::Activate(index) => {
                let action = level[index].action;
                if anchor.draft {
                    self.run_draft_menu_action(anchor.thread_id, action, window, cx);
                } else {
                    self.run_thread_menu_action(anchor.thread_id, action, window, cx);
                }
                true
            }
            MenuStep::CloseSubmenu => {
                self.thread_menu_copy_close_gen = self.thread_menu_copy_close_gen.wrapping_add(1);
                if let Some(menu) = &mut self.thread_menu {
                    menu.copy_open = false;
                    menu.cursor.in_sub = false;
                    menu.cursor.sub = None;
                }
                cx.notify();
                true
            }
            MenuStep::Close => {
                self.thread_menu = None;
                self.thread_menu_copy_close_gen = self.thread_menu_copy_close_gen.wrapping_add(1);
                cx.notify();
                true
            }
            MenuStep::CloseForTab => {
                self.thread_menu = None;
                self.thread_menu_copy_close_gen = self.thread_menu_copy_close_gen.wrapping_add(1);
                // Tab goes on from the row that opened the menu.
                let opener = self
                    .thread_menu_return_focus
                    .take()
                    .unwrap_or_else(|| self.focus_handle.clone());
                window.focus(&opener, cx);
                if backwards {
                    window.focus_prev(cx);
                } else {
                    window.focus_next(cx);
                }
                cx.notify();
                true
            }
            MenuStep::Consumed => true,
            MenuStep::Ignored => false,
        }
    }

    /// `Escape` closes the open submenu first, then the menu, then the other shell popovers.
    pub(crate) fn escape_shell_popovers(&mut self, cx: &mut Context<'_, Self>) -> bool {
        if let Some(menu) = &mut self.thread_menu
            && menu.cursor.in_sub
            && menu.copy_open
        {
            menu.copy_open = false;
            menu.cursor.in_sub = false;
            menu.cursor.sub = None;
            cx.notify();
            return true;
        }
        self.dismiss_shell_popovers(cx)
    }

    /// Keeps the open menu's keyboard in step with the menu: it takes the keyboard when it
    /// opens, and gives it back to what had it when it closes (`previouslyFocusedElement`),
    /// unless the keyboard moved elsewhere meanwhile.
    pub(super) fn sync_thread_menu_focus(
        &mut self,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if self.thread_menu.is_some() {
            self.thread_menu_returning = false;
            if std::mem::take(&mut self.thread_menu_focus_pending) {
                let opener = window
                    .focused(cx)
                    .filter(|focused| *focused != self.thread_menu_focus);
                if opener.is_some() || self.thread_menu_return_focus.is_none() {
                    self.thread_menu_return_focus = opener;
                }
                let menu = self.thread_menu_focus.clone();
                window.defer(cx, move |window, cx| window.focus(&menu, cx));
            }
        } else {
            self.thread_menu_focus_pending = false;
            if self.thread_menu_focus.is_focused(window) {
                // The hand-back lands after this frame; a second frame must not redo it.
                if !std::mem::replace(&mut self.thread_menu_returning, true) {
                    self.give_menu_focus_back(window, cx);
                }
            } else {
                self.thread_menu_returning = false;
                self.thread_menu_return_focus = None;
            }
        }
    }

    fn give_menu_focus_back(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let handle = self
            .thread_menu_return_focus
            .take()
            .unwrap_or_else(|| self.focus_handle.clone());
        window.defer(cx, move |window, cx| window.focus(&handle, cx));
    }

    /// The undo notice's button leaves with the notice; the keyboard must not stay on it.
    pub(super) fn sync_undo_notice_focus(
        &mut self,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if self.discards.notice().is_none()
            && self.discard_failure.is_none()
            && self.undo_focus.is_focused(window)
        {
            let root = self.focus_handle.clone();
            window.defer(cx, move |window, cx| window.focus(&root, cx));
        }
    }

    /// Every keystroke, before key bindings and text fields see it (`registerCommands` with
    /// `capture: true`): the open menu's keys, and `⌘Z` for a discard notice.
    pub(super) fn intercept_keystroke(
        &mut self,
        event: &KeystrokeEvent,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        // GPUI still calls the first key handler of the window after an interceptor stopped
        // the key; `keystroke_consumed` tells the root's handler to leave it.
        self.keystroke_consumed = false;
        let keystroke = &event.keystroke;
        let mods = key_mods(&keystroke.modifiers);
        if self.thread_menu.is_some() && self.thread_menu_focus.is_focused(window) {
            if let Some(key) = menu_key(&keystroke.key, mods)
                && self.thread_menu_key(key, keystroke.modifiers.shift, window, cx)
            {
                self.consume_keystroke(cx);
            }
            return;
        }
        if !is_undo_key(&keystroke.key, mods) {
            // Another key hands `⌘Z` back to text fields.
            if !is_modifier_key(&keystroke.key) {
                self.discards.release_claim();
            }
            return;
        }
        let in_context = |name: &str| {
            event
                .context_stack
                .iter()
                .any(|context| context.contains(name))
        };
        let scene = UndoShortcutScene {
            terminal_focus: in_context("Terminal"),
            editable_focus: in_context("Input"),
            overlay_open: self.settings_modal.is_some()
                || self.command_palette.is_some()
                || self.chat.read(cx).model_picker_open(cx),
            sidebar_visible: self.layout.sidebar_open,
            has_notice: self.discards.notice().is_some(),
            claimed: self.discards.claims_shortcut(),
        };
        if undo_shortcut_applies(scene) {
            self.consume_keystroke(cx);
            self.undo_discard_draft(cx);
        }
    }

    fn consume_keystroke(&mut self, cx: &mut Context<'_, Self>) {
        self.keystroke_consumed = true;
        cx.stop_propagation();
    }

    /// Keeps a discarded draft for `Undo`, with the ones before it, and ends the notice a few
    /// seconds after the last discard.
    pub(super) fn offer_draft_undo(
        &mut self,
        discarded: DiscardedDraft,
        cx: &mut Context<'_, Self>,
    ) {
        self.discard_failure = None;
        let generation = self.discards.push(discarded);
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_secs(DISCARD_UNDO_SECS))
                .await;
            let _ = this.update(cx, |app, cx| {
                if app.discards.expire(generation) {
                    cx.notify();
                }
            });
        })
        .detach();
    }

    /// `Undo` on the notice or `⌘Z`: every discard of the notice comes back. A thread whose
    /// composer holds new input since keeps it, and the notice says so.
    pub(crate) fn undo_discard_draft(&mut self, cx: &mut Context<'_, Self>) {
        let mut failed = false;
        for discarded in self.discards.undo() {
            failed |= !self.restore_discarded(discarded, cx);
        }
        if failed {
            self.show_undo_failure(UNDO_FAILED_NEW_CONTENT, cx);
        }
        self.settle_drafts(cx);
        cx.notify();
    }

    /// Whether the discarded input came back: a draft always, a thread's input unless the
    /// thread has new input (`The draft has new content.`).
    fn restore_discarded(&mut self, discarded: DiscardedDraft, cx: &mut Context<'_, Self>) -> bool {
        match discarded {
            DiscardedDraft::New {
                session,
                content,
                project_key,
            } => {
                if let Some(content) = content {
                    self.chat.update(cx, |chat, cx| {
                        chat.restore_draft(&session.draft_id, content, cx)
                    });
                }
                if let Some(project_key) = project_key
                    && self.drafts.slot_is_free(&project_key)
                {
                    self.drafts.map(&project_key, &session.draft_id);
                }
                self.drafts.park(session);
                true
            }
            DiscardedDraft::Thread { thread_id, content } => {
                let mut has_new_input = false;
                self.chat
                    .read(cx)
                    .visit_thread_drafts(cx, |id, text, count| {
                        has_new_input |= id == thread_id && draft_has_content(text, count);
                    });
                if has_new_input {
                    return false;
                }
                self.chat.update(cx, |chat, cx| {
                    chat.restore_thread_draft(&thread_id, content, cx)
                });
                true
            }
        }
    }

    fn show_undo_failure(&mut self, reason: &'static str, cx: &mut Context<'_, Self>) {
        self.discard_failure = Some(reason);
        self.discard_failure_generation = self.discard_failure_generation.wrapping_add(1);
        let generation = self.discard_failure_generation;
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_secs(DISCARD_UNDO_SECS))
                .await;
            let _ = this.update(cx, |app, cx| {
                if app.discard_failure_generation == generation
                    && app.discard_failure.take().is_some()
                {
                    cx.notify();
                }
            });
        })
        .detach();
    }

    /// The thread was deleted here: its unsent input goes with it (`clearComposerDraftForThread`
    /// in `useThreadActions` `deleteThread`).
    pub(super) fn forget_thread_draft(&mut self, thread_id: &str, cx: &mut Context<'_, Self>) {
        self.chat
            .update(cx, |chat, cx| chat.forget_thread_draft(thread_id, cx));
        self.settle_drafts(cx);
        cx.notify();
    }
}

#[cfg(test)]
impl ConnApp {
    /// The sidebar rows the keyboard can reach, top to bottom.
    pub(crate) fn sidebar_row_keys_for_test(&self) -> Vec<String> {
        self.sidebar_tree
            .rows()
            .iter()
            .map(|row| row.key.clone())
            .collect()
    }

    /// The row that has the keyboard, not one of its buttons.
    pub(crate) fn sidebar_focused_row_for_test(&self, window: &Window) -> Option<String> {
        self.sidebar_tree
            .rows()
            .iter()
            .find(|row| self.sidebar_tree.is_focused(&row.key, window))
            .map(|row| row.key.clone())
    }

    pub(crate) fn focus_sidebar_row_for_test(
        &mut self,
        key: &str,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.sidebar_tree.focus(key, window, cx);
    }

    pub(crate) fn selected_thread_for_test(&self) -> Option<&str> {
        self.layout.selected_thread_id.as_deref()
    }

    pub(crate) fn renaming_thread_for_test(&self) -> Option<&str> {
        self.renaming_thread_id.as_deref()
    }

    pub(crate) fn settled_shelf_open_for_test(&self) -> bool {
        self.collapsed_projects.contains(SETTLED_SHELF_TOGGLE_KEY)
    }

    /// The label of the row the menu keyboard is on, in the submenu when it is there.
    pub(crate) fn thread_menu_highlight_for_test(&self) -> Option<String> {
        let menu = self.thread_menu.as_ref()?;
        let items = self.thread_menu_items(menu)?;
        let parent = items.iter().find(|item| !item.children.is_empty());
        let (level, at) = match parent {
            Some(parent) if menu.cursor.in_sub => (&parent.children, menu.cursor.sub),
            _ => (&items, menu.cursor.root),
        };
        level.get(at?).map(|item| item.label.clone())
    }
}

#[cfg(test)]
impl ConnApp {
    pub(crate) fn forget_thread_draft_for_test(
        &mut self,
        thread_id: &str,
        cx: &mut Context<'_, Self>,
    ) {
        self.forget_thread_draft(thread_id, cx);
    }
}
