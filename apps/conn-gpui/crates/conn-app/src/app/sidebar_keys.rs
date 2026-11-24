//! The keyboard behaviour of the thread sidebar, as Conn has it: arrow keys between rows
//! (`lib/sidebarTree.ts`), arrow keys in the thread and draft menus (`contextMenuFallback.ts`),
//! the search box working its results (`Sidebar.tsx` `handleThreadSearchKeyDown`), `⌘⇧[` and
//! `⌘⇧]` between threads (`thread.previous`, `thread.next`), and `⌘Z` for discarded drafts and
//! settled threads (`hooks/showThreadUndoNotice.ts`, `lib/discardComposerDraft.ts`,
//! `hooks/useThreadActions.ts`). What each key does comes from `conn_state::sidebar_nav` and
//! `conn_state::discard_undo`; this file applies it to the app.

use std::collections::HashSet;

use conn_state::{
    BulkFacts, DISCARD_UNDO_SECS, KeyMods, MenuKey, MenuNavItem, MenuStep, RowClick, RowKey,
    RowKind, SETTLED_MORE_ROW, SearchKey, SettleUndoStep, ShellState, THREAD_JUMP_HINT_DELAY_MS,
    ThreadStep, TreeStep, UNDO_FAILED_NEW_CONTENT, UndoAction, UndoShortcutScene, adjacent_thread,
    draft_has_content, first_enabled, is_modifier_key, is_undo_key, jump_target, menu_key,
    menu_step, row_click, row_key, row_kind, search_highlight_index, search_key_unless_composing,
    search_step, shows_jump_hints, thread_jump_key, thread_traversal_key, traversal_order,
    tree_key, tree_step, undo_failure_text, undo_shortcut_applies,
};
use gpui_kit::{
    Context, EntityInputHandler as _, Focusable as _, KeyDownEvent, KeystrokeEvent, Modifiers,
    Window,
};

use super::{ConnApp, DiscardedDraft, ThreadUndoKind, UndoEntry};
use crate::sidebar::thread_list::{
    SidebarLists, current_unix_secs, parse_iso8601_unix_secs, sidebar_lists,
};
use crate::sidebar::thread_menu::{MenuCursor, ThreadMenuAction, ThreadMenuItem};

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
                Some(TreeStep::Toggle(_)) => self.toggle_settled_shelf(cx),
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
            // The footer's key is a shelf key too, but it reads the next page and does not close
            // the shelf.
            (RowKind::Shelf(_), RowKey::Activate) if row == SETTLED_MORE_ROW => {
                self.show_more_settled(cx);
            }
            (RowKind::Shelf(_), RowKey::Activate) => self.toggle_settled_shelf(cx),
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
                    self.open_row_menu(id.to_owned(), position, cx);
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
        // `Escape` lets go of a row held or swept (`SidebarPointerSensor` `keydown`).
        if self.pointer_captured() && keystroke.key == "escape" {
            self.cancel_pointer_gesture(cx);
            self.consume_keystroke(cx);
            return;
        }
        // `Escape` closes the workspace menu of the rail, which holds no focus of its own.
        if self.rail_menu.is_some() && keystroke.key == "escape" {
            self.dismiss_shell_popovers(cx);
            self.consume_keystroke(cx);
            return;
        }
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
        if window.focused(cx).is_none() && self.thread_shortcut(&keystroke.key, mods, cx) {
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

    /// Keeps a thread's settle, unpin, snooze or archive for `Undo` (`showThreadUndoNotice`,
    /// shown once the server took the action). The same action on the thread again replaces its
    /// older entry, as its claim does (`ThreadUndo.begin`).
    pub(super) fn offer_thread_undo(
        &mut self,
        thread_id: String,
        kind: ThreadUndoKind,
        plan: Vec<SettleUndoStep>,
        cx: &mut Context<'_, Self>,
    ) {
        self.forget_thread_undo(&thread_id, &[kind]);
        self.offer_undo(
            kind.action(),
            UndoEntry::Thread {
                thread_id,
                kind,
                plan,
            },
            cx,
        );
    }

    /// `ThreadUndo.invalidate(kind, thread)`: something else changed the thread's place, so
    /// undoing these actions would undo the wrong thing.
    pub(super) fn forget_thread_undo(&mut self, thread_id: &str, kinds: &[ThreadUndoKind]) {
        self.discards.retain(|entry| {
            !matches!(entry, UndoEntry::Thread { thread_id: id, kind, .. }
                if id == thread_id && kinds.contains(kind))
        });
    }

    fn offer_undo(&mut self, action: UndoAction, entry: UndoEntry, cx: &mut Context<'_, Self>) {
        self.discard_failure = None;
        let generation = self.discards.push_action(action, entry);
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_secs(DISCARD_UNDO_SECS))
                .await;
            let _ = this.update(cx, |app, cx| app.expire_undo(generation, cx));
        })
        .detach();
        cx.notify();
    }

    /// Ends the notice of `generation`. A discarded draft can no longer come back, so its
    /// parked right panel and browsers go too.
    pub(crate) fn expire_undo(&mut self, generation: u64, cx: &mut Context<'_, Self>) {
        let expired = self.discards.expire_entries(generation);
        if expired.is_empty() {
            return;
        }
        for entry in expired {
            if let UndoEntry::Draft(DiscardedDraft::New { session, .. }) = entry {
                let owner = self.panel_owner_of_draft(&session.draft_id, &session.project_id);
                self.forget_thread_panel(&owner, cx);
            }
        }
        cx.notify();
    }

    /// `Undo` on the notice or `⌘Z`: every action the notice covers comes back. A thread whose
    /// composer holds new input since keeps it, and the notice says so.
    pub(crate) fn undo_latest_action(&mut self, cx: &mut Context<'_, Self>) {
        let mut failed = false;
        for entry in self.discards.undo() {
            match entry {
                UndoEntry::Draft(discarded) => failed |= !self.restore_discarded(discarded, cx),
                UndoEntry::Thread {
                    thread_id,
                    kind,
                    plan,
                } => self.undo_thread(thread_id, kind, plan, cx),
            }
        }
        if failed {
            self.show_undo_failure(UNDO_FAILED_NEW_CONTENT, cx);
        }
        self.settle_drafts(cx);
        cx.notify();
    }

    /// Runs the commands that bring a thread back, each once the one before it worked
    /// (`executeThreadUndo`). A failure says so in the notice.
    fn undo_thread(
        &mut self,
        thread_id: String,
        kind: ThreadUndoKind,
        plan: Vec<SettleUndoStep>,
        cx: &mut Context<'_, Self>,
    ) {
        let failure = undo_failure_text(kind.action());
        let Some(connection) = self.connection_for_thread(&thread_id) else {
            self.show_undo_failure(failure, cx);
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
                    eprintln!("undo {kind:?}: {error}");
                    let _ = this.update(cx, |app, cx| {
                        app.show_undo_failure(failure, cx);
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
    /// every settled one, then those listed for their messages (`threadSearchResults`).
    fn sidebar_search_results(&self, query: &str) -> Vec<String> {
        let SidebarLists {
            pinned,
            active,
            settled,
            messages,
            ..
        } = sidebar_lists(
            &self.shell,
            &self.orbit.workspaces,
            self.active_workspace.as_deref(),
            query,
            &self.sidebar.search.order,
            None,
        );
        pinned
            .iter()
            .chain(&active)
            .chain(&settled)
            .chain(&messages)
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
        if searching {
            self.refresh_message_matches(&query);
        }
        let results = if searching {
            self.sidebar_search_results(&query)
        } else {
            Vec::new()
        };
        // `event.nativeEvent.isComposing`: a key typed while an input method composes text
        // belongs to it (`Enter` commits the composition, `Escape` cancels it).
        let composing = self.sidebar_search_input.update(cx, |input, cx| {
            input.marked_text_range(window, cx).is_some()
        });
        let Some(action) = search_key_unless_composing(key, searching, results.len(), composing)
        else {
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

    /// The thread shortcuts: `thread.previous` / `thread.next` (`⌘⇧[` / `⌘⇧]`) open the thread
    /// above or below the open one, in sidebar order, and stop at the ends;
    /// `thread.jump.1`..`9` (`⌘1`..`⌘9`) open the thread at that place of the same order. Conn
    /// leaves out key repeats and ignores the keys while the command palette or the model picker
    /// is open. Returns whether a thread opened.
    pub(crate) fn thread_traversal_key_down(
        &mut self,
        event: &KeyDownEvent,
        cx: &mut Context<'_, Self>,
    ) -> bool {
        !event.is_held
            && self.thread_shortcut(
                &event.keystroke.key,
                key_mods(&event.keystroke.modifiers),
                cx,
            )
    }

    /// Runs the thread shortcut `key` is, if it is one.
    fn thread_shortcut(&mut self, key: &str, mods: KeyMods, cx: &mut Context<'_, Self>) -> bool {
        if let Some(step) = thread_traversal_key(key, mods) {
            return self.traverse_threads(step, cx);
        }
        if let Some(index) = thread_jump_key(key, mods) {
            return self.jump_to_thread(index, cx);
        }
        false
    }

    /// An overlay that owns the keyboard leaves the thread shortcuts alone.
    fn overlay_has_keyboard(&self, cx: &gpui_kit::App) -> bool {
        self.command_palette.is_some()
            || self.settings_modal.is_some()
            || self.chat.read(cx).model_picker_open(cx)
    }

    /// Opens the thread `step` away from the open one, unless an overlay has the keyboard.
    fn traverse_threads(&mut self, step: ThreadStep, cx: &mut Context<'_, Self>) -> bool {
        if self.overlay_has_keyboard(cx) {
            return false;
        }
        let order = self.thread_traversal_ids();
        let open = self.open_row_thread();
        let Some(target) = adjacent_thread(&order, open, step).map(str::to_owned) else {
            return false;
        };
        self.select_thread(target.as_str(), cx);
        self.sidebar_tree.reveal_row(&target);
        true
    }

    /// `thread.jump.N`: opens the thread at place `index` of the traversal order, as the jump
    /// numbers on the rows show. A place with no thread does nothing.
    fn jump_to_thread(&mut self, index: usize, cx: &mut Context<'_, Self>) -> bool {
        if self.overlay_has_keyboard(cx) {
            return false;
        }
        let order = self.thread_traversal_ids();
        let Some(target) = jump_target(&order, index).map(str::to_owned) else {
            return false;
        };
        self.select_thread(target.as_str(), cx);
        self.sidebar_tree.reveal_row(&target);
        true
    }

    /// `⌘` goes down or up. Held `200ms` on its own it shows the jump numbers on the rows, and
    /// any other change of the modifiers hides them again (`createModifierHoldStore`). Conn keeps
    /// them off while a terminal has the keyboard, where holding a modifier is routine.
    pub(crate) fn modifiers_changed(
        &mut self,
        modifiers: &Modifiers,
        window: &Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.jump_hint_generation = self.jump_hint_generation.wrapping_add(1);
        let generation = self.jump_hint_generation;
        let hide = self.jump_hints;
        self.jump_hints = false;
        if hide {
            cx.notify();
        }
        let terminal_focus = window
            .context_stack()
            .iter()
            .any(|context| context.contains("Terminal"));
        if !shows_jump_hints(key_mods(modifiers)) || terminal_focus {
            return;
        }
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(THREAD_JUMP_HINT_DELAY_MS))
                .await;
            let _ = this.update(cx, |app, cx| {
                if app.jump_hint_generation == generation {
                    app.jump_hints = true;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    /// The threads whose rows wear a jump number while the hints show, in the order of their
    /// numbers; none while they are hidden. The hints go while the model picker, which takes
    /// `⌘1`..`⌘9` for itself, is open.
    pub(crate) fn jump_hint_order(&self, window: &Window, cx: &gpui_kit::App) -> Vec<String> {
        if self.jump_hints
            && window.is_window_active()
            && shows_jump_hints(key_mods(&window.modifiers()))
            && !self.chat.read(cx).model_picker_open(cx)
        {
            self.thread_traversal_ids()
        } else {
            Vec::new()
        }
    }

    /// A click on a thread row (`handleThreadClick`): `⌘`-click picks the thread for a bulk action
    /// or takes it back out, `Shift`-click picks every thread from the last one opened or picked
    /// to this one, and a plain click opens it.
    pub(crate) fn thread_row_clicked(
        &mut self,
        thread_id: &str,
        modifiers: &Modifiers,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if self.click_suppressed() {
            return;
        }
        match row_click(key_mods(modifiers)) {
            RowClick::Toggle => {
                self.thread_selection.toggle(thread_id);
                cx.notify();
            }
            RowClick::Range => {
                let order = self.thread_traversal_ids();
                self.thread_selection.range_select_to(thread_id, &order);
                cx.notify();
            }
            RowClick::Open => self.open_thread_row(thread_id, window, cx),
        }
    }

    /// Files dropped on a thread row go to that thread's composer, and the thread opens when it
    /// is not the open one (`handleThreadFileDrop`).
    pub(crate) fn thread_files_dropped(
        &mut self,
        thread_id: &str,
        paths: Vec<std::path::PathBuf>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if paths.is_empty() {
            return;
        }
        if self.layout.selected_thread_id.as_deref() != Some(thread_id) || self.draft.is_some() {
            self.open_thread_row(thread_id, window, cx);
        }
        self.chat
            .update(cx, |chat, cx| chat.attach_paths(paths, window, cx));
    }

    /// The picked threads the sidebar still lists, in the order they were picked
    /// (`threadByKeyRef.has`).
    pub(super) fn bulk_targets(&self) -> Vec<String> {
        self.thread_selection.listed(&self.thread_traversal_ids())
    }

    /// What the picked threads are like, for the bulk menu.
    pub(super) fn bulk_facts(&self, ids: &[String]) -> BulkFacts {
        let threads: Vec<_> = ids
            .iter()
            .filter_map(|id| self.shell.find_thread(id))
            .collect();
        BulkFacts {
            selected: threads.len(),
            pinned: threads
                .iter()
                .filter(|thread| thread.pinned_at.as_ref().is_some_and(Option::is_some))
                .count(),
            settling: threads
                .iter()
                .filter(|thread| !ShellState::is_settled(thread))
                .count(),
            regenerating: threads
                .iter()
                .filter(|thread| {
                    thread
                        .title_regeneration
                        .as_ref()
                        .is_some_and(Option::is_some)
                })
                .count(),
        }
    }

    /// One row of the bulk menu, run on every picked thread; the selection ends with it
    /// (`clearSelection`), a delete takes only the deleted threads out.
    pub(super) fn run_bulk_action(
        &mut self,
        action: ThreadMenuAction,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let ids = self.bulk_targets();
        if ids.is_empty() {
            return;
        }
        let shell = &self.shell;
        let thread_is = |id: &str, test: fn(&conn_state::ThreadShell) -> bool| {
            shell.find_thread(id).is_some_and(test)
        };
        let pinned = |thread: &conn_state::ThreadShell| {
            thread.pinned_at.as_ref().is_some_and(Option::is_some)
        };
        let regenerating = |thread: &conn_state::ThreadShell| {
            thread
                .title_regeneration
                .as_ref()
                .is_some_and(Option::is_some)
        };
        match action {
            ThreadMenuAction::Unpin => {
                let targets: Vec<String> = ids
                    .iter()
                    .filter(|id| thread_is(id, pinned))
                    .cloned()
                    .collect();
                for id in targets {
                    self.pin_thread(id, false, cx);
                }
            }
            ThreadMenuAction::Settle => {
                // `settleThreads`: the open thread moves on to one that is not settling too.
                let targets: Vec<String> = ids
                    .iter()
                    .filter(|id| {
                        thread_is(id, |thread| !conn_state::ShellState::is_settled(thread))
                    })
                    .cloned()
                    .collect();
                let along: HashSet<String> = targets.iter().cloned().collect();
                for id in targets {
                    self.settle_thread_along(id, true, &along, cx);
                }
            }
            ThreadMenuAction::RegenerateTitle => {
                let targets: Vec<String> = ids
                    .iter()
                    .filter(|id| !thread_is(id, regenerating))
                    .cloned()
                    .collect();
                for id in targets {
                    self.dispatch_thread_command(
                        "regenerate title",
                        crate::commands::regenerate_thread_title(&id),
                        cx,
                    );
                }
            }
            ThreadMenuAction::MarkUnread => {
                for id in &ids {
                    self.dispatch_thread_command(
                        "mark unread",
                        crate::commands::mark_thread_unread(id),
                        cx,
                    );
                }
            }
            ThreadMenuAction::Delete => {
                self.confirm_delete_threads(ids, window, cx);
                return;
            }
            _ => return,
        }
        self.thread_selection.clear();
        cx.notify();
    }

    /// The thread whose row is current: the open thread, or the thread it is a subagent of when
    /// the sidebar does not list it (`routeRowThreadKey`). None while a draft is open.
    pub(super) fn open_row_thread(&self) -> Option<&str> {
        let open = self
            .layout
            .selected_thread_id
            .as_deref()
            .filter(|_| self.draft.is_none())?;
        Some(self.shell.listed_ancestor(open).unwrap_or(open))
    }

    /// The threads traversal walks (`orderedThreadKeys`): what the sidebar lists, search aside.
    /// The Settled shelf adds the rows it shows, a page of them while it is open.
    pub(super) fn thread_traversal_ids(&self) -> Vec<String> {
        let pending = self
            .sidebar
            .pending_drop
            .as_ref()
            .map(|p| (&p.drop, &p.thread));
        let SidebarLists { pinned, active, .. } = sidebar_lists(
            &self.shell,
            &self.orbit.workspaces,
            self.active_workspace.as_deref(),
            "",
            &[],
            pending,
        );
        fn ids<'a>(threads: &[&'a conn_state::ThreadShell]) -> Vec<&'a str> {
            threads.iter().map(|thread| thread.id.as_str()).collect()
        }
        let shelf = self.settled_shelf_rows();
        let shelf: Vec<&str> = shelf.iter().map(String::as_str).collect();
        traversal_order(
            &ids(&pinned),
            &ids(&active),
            &shelf,
            true,
            self.open_row_thread(),
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

    pub(crate) fn active_workspace_for_test(&self) -> Option<&str> {
        self.active_workspace.as_deref()
    }

    /// The threads picked for a bulk action, in the order they were picked.
    pub(crate) fn thread_selection_for_test(&self) -> Vec<String> {
        self.thread_selection.keys().to_vec()
    }

    /// An input method composing `text` in the search box, as it does before a candidate is
    /// chosen.
    pub(crate) fn compose_in_search_for_test(
        &mut self,
        text: &str,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.sidebar_search_input.update(cx, |input, cx| {
            input.focus(window, cx);
            let end = input.value().encode_utf16().count();
            input.replace_and_mark_text_in_range(Some(end..end), text, None, window, cx);
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
        self.offer_thread_undo(thread_id.to_owned(), ThreadUndoKind::Settle, plan, cx);
    }

    /// An unpin the server took (`unpinThread`), as the action offers it.
    pub(crate) fn offer_unpin_undo_for_test(
        &mut self,
        thread_id: &str,
        cx: &mut Context<'_, Self>,
    ) {
        let plan = conn_state::plan_unpin_undo(None);
        self.offer_thread_undo(thread_id.to_owned(), ThreadUndoKind::Pin, plan, cx);
    }

    pub(crate) fn settled_shelf_open_for_test(&self) -> bool {
        self.sidebar.settled_expanded
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
