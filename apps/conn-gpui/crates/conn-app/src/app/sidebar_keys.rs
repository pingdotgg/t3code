//! The keyboard behaviour of the thread sidebar, as Conn has it: arrow keys between rows
//! (`lib/sidebarTree.ts`), arrow keys in the thread and draft menus (`contextMenuFallback.ts`),
//! the search box working its results (`Sidebar.tsx` `handleThreadSearchKeyDown`), `⌘⇧[` and
//! `⌘⇧]` between threads (`thread.previous`, `thread.next`), and `⌘Z` for discarded drafts and
//! settled threads (`hooks/showThreadUndoNotice.ts`, `lib/discardComposerDraft.ts`,
//! `hooks/useThreadActions.ts`). What each key does comes from `conn_state::sidebar_nav` and
//! `conn_state::discard_undo`; this file applies it to the app.

use conn_state::{
    DISCARD_UNDO_SECS, KeyMods, MenuKey, MenuNavItem, MenuStep, RowKey, RowKind, SearchKey,
    SettleUndoStep, ThreadStep, TreeStep, UNDO_FAILED_NEW_CONTENT, UNDO_FAILED_SETTLE, UndoAction,
    UndoShortcutScene, adjacent_thread, draft_has_content, first_enabled, is_modifier_key,
    is_undo_key, menu_key, menu_step, row_key, row_kind, search_highlight_index, search_key,
    search_step, thread_traversal_key, traversal_order, tree_key, tree_step, undo_shortcut_applies,
};
use gpui_kit::{Context, Focusable as _, KeyDownEvent, KeystrokeEvent, Modifiers, Window};

use super::{ConnApp, DiscardedDraft, UndoEntry};
use crate::sidebar::thread_list::{
    SETTLED_SHELF_TOGGLE_KEY, SidebarThreads, current_unix_secs, parse_iso8601_unix_secs,
    sidebar_threads,
};
use crate::sidebar::thread_menu::{MenuCursor, ThreadMenuItem};

fn key_mods(modifiers: &Modifiers) -> KeyMods {
    KeyMods {
        shift: modifiers.shift,
        alt: modifiers.alt,
        control: modifiers.control,
        platform: modifiers.platform,
    }
}

/// The command a step of an undone settle sends. A snooze whose wake time has passed sends
/// none: the server refuses it (`executeThreadUndo` skips it too).
fn settle_undo_command(
    thread_id: &str,
    step: &SettleUndoStep,
) -> Option<Result<conn_contract::OrchestrationV2Command, serde_json::Error>> {
    use crate::commands;
    Some(match step {
        SettleUndoStep::Unsettle {
            restore_unsettled_at,
        } => commands::unsettle_thread_restoring(
            thread_id,
            restore_unsettled_at.as_ref().map(Option::as_deref),
        ),
        SettleUndoStep::Pin { order_key } => {
            commands::pin_thread_at(thread_id, order_key.as_deref())
        }
        SettleUndoStep::ReorderActive { order_key } => {
            commands::reorder_active_thread(thread_id, order_key)
        }
        SettleUndoStep::Snooze { snoozed_until } => {
            if parse_iso8601_unix_secs(snoozed_until).is_none_or(|at| at <= current_unix_secs()) {
                return None;
            }
            commands::snooze_thread(thread_id, snoozed_until)
        }
        SettleUndoStep::Unsnooze => commands::unsnooze_thread(thread_id),
        SettleUndoStep::Unarchive => commands::archive_thread(thread_id, false),
    })
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
        if self
            .sidebar_search_input
            .focus_handle(cx)
            .is_focused(window)
            && self.sidebar_search_key(&keystroke.key, window, cx)
        {
            self.consume_keystroke(cx);
            return;
        }
        // Key repeats cannot be told apart here (Conn leaves them out), so this handles the
        // key only when nothing has the keyboard and the root's key handler is out of reach.
        if window.focused(cx).is_none()
            && let Some(step) = thread_traversal_key(&keystroke.key, mods)
            && self.traverse_threads(step, cx)
        {
            self.consume_keystroke(cx);
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
            self.undo_latest_action(cx);
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
        self.offer_undo(UndoAction::Discarded, UndoEntry::Draft(discarded), cx);
    }

    /// Keeps a settled thread for `Undo` (`settleThread` shows the notice once the server took
    /// the settle). A thread settled again replaces its older entry, as its claim does.
    pub(super) fn offer_settle_undo(
        &mut self,
        thread_id: String,
        plan: Vec<SettleUndoStep>,
        cx: &mut Context<'_, Self>,
    ) {
        self.forget_settle_undo(&thread_id);
        self.offer_undo(
            UndoAction::Settled,
            UndoEntry::Settled { thread_id, plan },
            cx,
        );
    }

    /// `ThreadUndo.invalidate("settle", thread)`: something else un-settled, pinned or deleted
    /// the thread, so undoing its settle would undo the wrong thing.
    pub(super) fn forget_settle_undo(&mut self, thread_id: &str) {
        self.discards.retain(|entry| {
            !matches!(entry, UndoEntry::Settled { thread_id: settled, .. } if settled == thread_id)
        });
    }

    fn offer_undo(&mut self, action: UndoAction, entry: UndoEntry, cx: &mut Context<'_, Self>) {
        self.discard_failure = None;
        let generation = self.discards.push_action(action, entry);
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
        cx.notify();
    }

    /// `Undo` on the notice or `⌘Z`: every action the notice covers comes back. A thread whose
    /// composer holds new input since keeps it, and the notice says so.
    pub(crate) fn undo_latest_action(&mut self, cx: &mut Context<'_, Self>) {
        let mut failed = false;
        for entry in self.discards.undo() {
            match entry {
                UndoEntry::Draft(discarded) => failed |= !self.restore_discarded(discarded, cx),
                UndoEntry::Settled { thread_id, plan } => self.undo_settled(thread_id, plan, cx),
            }
        }
        if failed {
            self.show_undo_failure(UNDO_FAILED_NEW_CONTENT, cx);
        }
        self.settle_drafts(cx);
        cx.notify();
    }

    /// Runs the commands that bring a settled thread back, each once the one before it worked
    /// (`executeThreadUndo`). A failure says so in the notice.
    fn undo_settled(
        &mut self,
        thread_id: String,
        plan: Vec<SettleUndoStep>,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(connection) = self.connection.clone() else {
            self.show_undo_failure(UNDO_FAILED_SETTLE, cx);
            return;
        };
        cx.spawn(async move |this, cx| {
            for step in plan {
                let Some(command) = settle_undo_command(&thread_id, &step) else {
                    continue;
                };
                let sent = match command {
                    Ok(command) => connection
                        .dispatch_command(command)
                        .await
                        .map_err(|error| error.to_string()),
                    Err(error) => Err(error.to_string()),
                };
                if let Err(error) = sent {
                    eprintln!("undo settle: {error}");
                    let _ = this.update(cx, |app, cx| {
                        app.show_undo_failure(UNDO_FAILED_SETTLE, cx);
                    });
                    return;
                }
            }
        })
        .detach();
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
        cx.notify();
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

    /// The sidebar search box's text.
    pub(crate) fn sidebar_search_query(&self, cx: &gpui_kit::App) -> String {
        self.sidebar_search_input.read(cx).value().to_string()
    }

    /// The threads the search lists, in the order the arrow keys walk them: pinned, active,
    /// then every settled one (`threadSearchResults`).
    fn sidebar_search_results(&self, query: &str) -> Vec<String> {
        let SidebarThreads {
            pinned,
            active,
            settled,
        } = sidebar_threads(
            &self.shell,
            &self.orbit.workspaces,
            self.active_workspace.as_deref(),
            query,
        );
        pinned
            .iter()
            .chain(&active)
            .chain(&settled)
            .map(|thread| thread.id.clone())
            .collect()
    }

    /// A key in the search box (`handleThreadSearchKeyDown`): the arrows move the highlight
    /// over the results and wrap, `Enter` opens the highlighted one, `Escape` clears the
    /// search. Returns whether the search box used the key.
    fn sidebar_search_key(
        &mut self,
        key: &str,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> bool {
        let query = self.sidebar_search_query(cx);
        let searching = !query.trim().is_empty();
        let results = if searching {
            self.sidebar_search_results(&query)
        } else {
            Vec::new()
        };
        let Some(action) = search_key(key, searching, results.len()) else {
            return false;
        };
        let active =
            search_highlight_index(&results, self.sidebar_search_highlight.as_deref()).unwrap_or(0);
        match action {
            SearchKey::Clear => self.clear_sidebar_search(false, window, cx),
            SearchKey::Next | SearchKey::Previous => {
                let id = results[search_step(results.len(), active, action)].clone();
                // `scrollIntoView({ block: "nearest" })` on the highlighted result.
                self.sidebar_tree.reveal_row(&id);
                self.sidebar_search_highlight = Some(id);
                cx.notify();
            }
            SearchKey::Open => {
                let id = results[active].clone();
                self.open_search_result(&id, window, cx);
            }
        }
        true
    }

    /// Empties the search box (`clearThreadSearch`); the clear button also gives the keyboard
    /// back to it.
    pub(crate) fn clear_sidebar_search(
        &mut self,
        refocus: bool,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.sidebar_search_highlight = None;
        self.sidebar_search_input.update(cx, |input, cx| {
            input.set_value(String::new(), window, cx);
            if refocus {
                input.focus(window, cx);
            }
        });
        cx.notify();
    }

    /// Opens a search result and ends the search (`selectThreadSearchResult`). The keyboard
    /// stays where it was.
    fn open_search_result(
        &mut self,
        thread_id: &str,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.clear_sidebar_search(false, window, cx);
        self.select_thread(thread_id, cx);
    }

    /// A click on a thread row: a search result also ends the search.
    pub(crate) fn open_thread_row(
        &mut self,
        thread_id: &str,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if self.sidebar_search_query(cx).trim().is_empty() {
            self.select_thread(thread_id, cx);
        } else {
            self.open_search_result(thread_id, window, cx);
        }
    }

    /// The pointer is over a search result: the highlight follows it (`onMouseMove`).
    pub(crate) fn highlight_search_result(&mut self, thread_id: &str, cx: &mut Context<'_, Self>) {
        if self.sidebar_search_highlight.as_deref() != Some(thread_id) {
            self.sidebar_search_highlight = Some(thread_id.to_owned());
            cx.notify();
        }
    }

    /// `thread.previous` / `thread.next` (`⌘⇧[` / `⌘⇧]`): opens the thread above or below the
    /// open one, in sidebar order, and stops at the ends. Conn leaves out key repeats and
    /// ignores the keys while the command palette or the model picker is open. Returns whether
    /// a thread opened.
    pub(crate) fn thread_traversal_key_down(
        &mut self,
        event: &KeyDownEvent,
        cx: &mut Context<'_, Self>,
    ) -> bool {
        let Some(step) =
            thread_traversal_key(&event.keystroke.key, key_mods(&event.keystroke.modifiers))
        else {
            return false;
        };
        !event.is_held && self.traverse_threads(step, cx)
    }

    /// Opens the thread `step` away from the open one, unless an overlay has the keyboard.
    fn traverse_threads(&mut self, step: ThreadStep, cx: &mut Context<'_, Self>) -> bool {
        if self.command_palette.is_some()
            || self.settings_modal.is_some()
            || self.chat.read(cx).model_picker_open(cx)
        {
            return false;
        }
        let order = self.thread_traversal_ids();
        let open = self
            .layout
            .selected_thread_id
            .as_deref()
            .filter(|_| self.draft.is_none());
        let Some(target) = adjacent_thread(&order, open, step).map(str::to_owned) else {
            return false;
        };
        self.select_thread(target.as_str(), cx);
        self.sidebar_tree.reveal_row(&target);
        true
    }

    /// The threads traversal walks (`orderedThreadKeys`): what the sidebar lists, search aside.
    fn thread_traversal_ids(&self) -> Vec<String> {
        let SidebarThreads {
            pinned,
            active,
            settled,
        } = sidebar_threads(
            &self.shell,
            &self.orbit.workspaces,
            self.active_workspace.as_deref(),
            "",
        );
        fn ids<'a>(threads: &[&'a conn_state::ThreadShell]) -> Vec<&'a str> {
            threads.iter().map(|thread| thread.id.as_str()).collect()
        }
        traversal_order(
            &ids(&pinned),
            &ids(&active),
            &ids(&settled),
            self.collapsed_projects.contains(SETTLED_SHELF_TOGGLE_KEY),
            self.layout
                .selected_thread_id
                .as_deref()
                .filter(|_| self.draft.is_none()),
        )
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

    /// The result the arrow keys highlighted in the search box, as the list shows it.
    pub(crate) fn search_highlight_for_test(&self, cx: &gpui_kit::App) -> Option<String> {
        let query = self.sidebar_search_query(cx);
        let results = self.sidebar_search_results(&query);
        search_highlight_index(&results, self.sidebar_search_highlight.as_deref())
            .map(|at| results[at].clone())
    }

    pub(crate) fn search_results_for_test(&self, cx: &gpui_kit::App) -> Vec<String> {
        self.sidebar_search_results(&self.sidebar_search_query(cx))
    }

    /// Types `query` into the search box, which has the keyboard.
    pub(crate) fn search_for_test(
        &mut self,
        query: &str,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.sidebar_search_input.update(cx, |input, cx| {
            input.set_value(query.to_owned(), window, cx);
            input.focus(window, cx);
        });
        cx.notify();
    }

    pub(crate) fn root_focus_for_test(&self) -> gpui_kit::FocusHandle {
        self.focus_handle.clone()
    }

    pub(crate) fn traversal_ids_for_test(&self) -> Vec<String> {
        self.thread_traversal_ids()
    }

    pub(crate) fn search_text_for_test(&self, cx: &gpui_kit::App) -> String {
        self.sidebar_search_query(cx)
    }

    /// A settle the server took, as `settle_thread` offers it.
    pub(crate) fn offer_settle_undo_for_test(
        &mut self,
        thread_id: &str,
        cx: &mut Context<'_, Self>,
    ) {
        let plan = conn_state::plan_settle_undo(None);
        self.offer_settle_undo(thread_id.to_owned(), plan, cx);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_snooze_that_has_ended_is_not_sent_back() {
        let snooze = |until: &str| SettleUndoStep::Snooze {
            snoozed_until: until.to_owned(),
        };
        assert!(settle_undo_command("t1", &snooze("2000-01-01T00:00:00Z")).is_none());
        assert!(settle_undo_command("t1", &snooze("not a time")).is_none());
        assert!(matches!(
            settle_undo_command("t1", &snooze("2999-01-01T00:00:00Z")),
            Some(Ok(_))
        ));
        let unsettle = SettleUndoStep::Unsettle {
            restore_unsettled_at: Some(None),
        };
        assert!(matches!(settle_undo_command("t1", &unsettle), Some(Ok(_))));
    }
}
