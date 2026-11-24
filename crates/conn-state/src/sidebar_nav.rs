//! Keyboard navigation of the thread sidebar that does not depend on the toolkit: how the arrow
//! keys move between rows (Conn `lib/sidebarTree.ts`), what a key does on a row
//! (`SidebarThreadRow.tsx` and `SidebarDraftBlock.tsx` `handleKeyDown`), how the arrow keys
//! move through a context menu (`contextMenuFallback.ts`), how the search box works its results
//! (`Sidebar.tsx` `handleThreadSearchKeyDown`) and what `⌘⇧[` / `⌘⇧]` do (`thread.previous` /
//! `thread.next`). Plain data in and out, so the iPhone app can share it.

/// Modifier keys held with a key press.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct KeyMods {
    pub shift: bool,
    pub alt: bool,
    pub control: bool,
    pub platform: bool,
}

impl KeyMods {
    /// No modifier at all, shift included.
    #[must_use]
    pub fn none(self) -> bool {
        self == Self::default()
    }

    /// No modifier but, maybe, shift.
    #[must_use]
    pub fn none_but_shift(self) -> bool {
        !self.alt && !self.control && !self.platform
    }
}

/// Key of the settled shelf's header row (`data-sidebar-row="shelf:settled"`).
pub const SETTLED_SHELF_ROW: &str = "shelf:settled";

/// Key of a draft row (`data-sidebar-row="draft:<id>"`). A thread row's key is its thread id.
#[must_use]
pub fn draft_tree_key(draft_id: &str) -> String {
    format!("draft:{draft_id}")
}

/// What a row key names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowKind<'a> {
    /// A new-thread draft, by draft id.
    Draft(&'a str),
    /// A shelf header, by shelf name.
    Shelf(&'a str),
    /// A started thread, by thread id.
    Thread(&'a str),
}

/// The kind of row `key` names.
#[must_use]
pub fn row_kind(key: &str) -> RowKind<'_> {
    if let Some(id) = key.strip_prefix("draft:") {
        RowKind::Draft(id)
    } else if let Some(shelf) = key.strip_prefix("shelf:") {
        RowKind::Shelf(shelf)
    } else {
        RowKind::Thread(key)
    }
}

/// One keyboard-navigable row, in display order (`[data-sidebar-row]`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeRow {
    pub key: String,
    /// The row it sits under (`data-sidebar-parent`).
    pub parent: Option<String>,
    /// `Some(open)` for a row that expands and collapses (`aria-expanded`).
    pub expanded: Option<bool>,
}

impl TreeRow {
    /// A row with no parent that does not expand.
    #[must_use]
    pub fn leaf(key: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            parent: None,
            expanded: None,
        }
    }

    /// A row under `parent`.
    #[must_use]
    pub fn child(key: impl Into<String>, parent: &str) -> Self {
        Self {
            parent: Some(parent.to_owned()),
            ..Self::leaf(key)
        }
    }

    /// A row that expands and collapses.
    #[must_use]
    pub fn group(key: impl Into<String>, expanded: bool) -> Self {
        Self {
            expanded: Some(expanded),
            ..Self::leaf(key)
        }
    }
}

/// An arrow, `Home` or `End` key on a row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TreeKey {
    Next,
    Previous,
    First,
    Last,
    /// `ArrowRight`: expand a collapsed row, else enter its first child.
    Expand,
    /// `ArrowLeft`: collapse an expanded row, else go to its parent.
    Collapse,
}

/// The tree key `key` is. Any modifier, shift included, leaves the key to others.
#[must_use]
pub fn tree_key(key: &str, mods: KeyMods) -> Option<TreeKey> {
    if !mods.none() {
        return None;
    }
    match key {
        "down" => Some(TreeKey::Next),
        "up" => Some(TreeKey::Previous),
        "home" => Some(TreeKey::First),
        "end" => Some(TreeKey::Last),
        "right" => Some(TreeKey::Expand),
        "left" => Some(TreeKey::Collapse),
        _ => None,
    }
}

/// What a tree key does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TreeStep {
    /// Move the keyboard focus to the row. It is not opened.
    Focus(String),
    /// Expand or collapse the row.
    Toggle(String),
    /// The key is used up and nothing moves (the end of the list, a row without children).
    Stay,
}

/// The step `key` takes from the row `current` (`onKeyDown` in `sidebarTree.ts`): the ends do not
/// wrap. `None` when `current` is not a row, so the key is left alone.
#[must_use]
pub fn tree_step(rows: &[TreeRow], current: &str, key: TreeKey) -> Option<TreeStep> {
    let index = rows.iter().position(|row| row.key == current)?;
    let row = &rows[index];
    let focus = |target: Option<&TreeRow>| {
        target.map_or(TreeStep::Stay, |target| TreeStep::Focus(target.key.clone()))
    };
    Some(match key {
        TreeKey::Next => focus(rows.get(index + 1).or_else(|| rows.last())),
        TreeKey::Previous => focus(rows.get(index.saturating_sub(1))),
        TreeKey::First => focus(rows.first()),
        TreeKey::Last => focus(rows.last()),
        TreeKey::Expand if row.expanded == Some(false) => TreeStep::Toggle(row.key.clone()),
        TreeKey::Expand => focus(
            rows.iter()
                .find(|candidate| candidate.parent.as_deref() == Some(current)),
        ),
        TreeKey::Collapse if row.expanded == Some(true) => TreeStep::Toggle(row.key.clone()),
        TreeKey::Collapse => focus(
            row.parent
                .as_deref()
                .and_then(|parent| rows.iter().find(|candidate| candidate.key == parent)),
        ),
    })
}

/// Where the keyboard focus last was in the rows, to follow it when its row goes away.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FocusedRow {
    pub key: String,
    pub parent: Option<String>,
    pub index: usize,
}

/// The [`FocusedRow`] of `key` in `rows`.
#[must_use]
pub fn focused_row(rows: &[TreeRow], key: &str) -> Option<FocusedRow> {
    let index = rows.iter().position(|row| row.key == key)?;
    Some(FocusedRow {
        key: key.to_owned(),
        parent: rows[index].parent.clone(),
        index,
    })
}

/// The row that takes the keyboard when the focused row is gone (`restoreFocus`): the row itself
/// when it moved, else its parent, else the row at the same place.
#[must_use]
pub fn restore_target<'a>(rows: &'a [TreeRow], lost: &FocusedRow) -> Option<&'a str> {
    let by_key = |key: &str| rows.iter().find(|row| row.key == key);
    by_key(&lost.key)
        .or_else(|| lost.parent.as_deref().and_then(by_key))
        .or_else(|| rows.get(lost.index.min(rows.len().saturating_sub(1))))
        .map(|row| row.key.as_str())
}

/// What a key does on a focused row besides moving between rows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowKey {
    /// `Enter` or `Space`: open the row, or toggle a shelf.
    Activate,
    /// `F2`: rename the thread.
    Rename,
    /// `ContextMenu` or `Shift+F10`: open the row's menu below it.
    Menu,
}

/// `ContextMenu` and `Shift+F10`, with no other modifier.
#[must_use]
pub fn is_menu_key(key: &str, mods: KeyMods) -> bool {
    mods.none_but_shift() && (key == "menu" || (mods.shift && key == "f10"))
}

/// What `key` does on a focused row of `kind`. A draft row opens or shows its menu; a thread row
/// also renames on `F2`; a shelf header only toggles.
#[must_use]
pub fn row_key(kind: RowKind<'_>, key: &str, mods: KeyMods) -> Option<RowKey> {
    if matches!(kind, RowKind::Shelf(_)) {
        return matches!(key, "enter" | "space").then_some(RowKey::Activate);
    }
    if is_menu_key(key, mods) {
        return Some(RowKey::Menu);
    }
    match key {
        "enter" | "space" => Some(RowKey::Activate),
        "f2" if matches!(kind, RowKind::Thread(_)) => Some(RowKey::Rename),
        _ => None,
    }
}

/// A key inside an open context menu.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuKey {
    Next,
    Previous,
    First,
    Last,
    /// `ArrowRight`: open the highlighted row's submenu.
    Right,
    /// `ArrowLeft`: close the submenu.
    Left,
    /// `Enter` or `Space`.
    Activate,
    Escape,
    Tab,
}

/// The menu key `key` is. A modifier other than shift leaves the key to others.
#[must_use]
pub fn menu_key(key: &str, mods: KeyMods) -> Option<MenuKey> {
    if !mods.none_but_shift() {
        return None;
    }
    match key {
        "down" => Some(MenuKey::Next),
        "up" => Some(MenuKey::Previous),
        "home" => Some(MenuKey::First),
        "end" => Some(MenuKey::Last),
        "right" => Some(MenuKey::Right),
        "left" => Some(MenuKey::Left),
        "enter" | "space" => Some(MenuKey::Activate),
        "escape" => Some(MenuKey::Escape),
        "tab" => Some(MenuKey::Tab),
        _ => None,
    }
}

/// One action row of the open menu level (headers and separators are not listed).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MenuNavItem {
    pub enabled: bool,
    /// The row opens a submenu.
    pub submenu: bool,
}

/// What a menu key does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuStep {
    /// Highlight this row.
    Highlight(usize),
    /// Open this row's submenu and highlight its first action.
    OpenSubmenu(usize),
    /// Run this row.
    Activate(usize),
    /// Close the submenu; the highlight returns to its row.
    CloseSubmenu,
    /// Close the menu and give the keyboard back to the row that opened it.
    Close,
    /// Close the menu and let `Tab` go on from the row that opened it.
    CloseForTab,
    /// The key is used up and nothing changes.
    Consumed,
    /// The key is not for the menu.
    Ignored,
}

/// The step `key` takes in a menu level (`onKeyDown` in `contextMenuFallback.ts`). `highlighted`
/// is the row the keyboard is on, none while the menu has only just opened with the pointer.
/// Up and Down wrap around the enabled rows; disabled rows are skipped.
#[must_use]
pub fn menu_step(
    items: &[MenuNavItem],
    highlighted: Option<usize>,
    in_submenu: bool,
    key: MenuKey,
) -> MenuStep {
    let enabled: Vec<usize> = items
        .iter()
        .enumerate()
        .filter(|(_, item)| item.enabled)
        .map(|(index, _)| index)
        .collect();
    let position = highlighted.and_then(|row| enabled.iter().position(|&index| index == row));
    let step_to =
        |index: Option<&usize>| index.map_or(MenuStep::Consumed, |&i| MenuStep::Highlight(i));
    match key {
        MenuKey::Next => step_to(match position {
            None => enabled.first(),
            Some(at) => enabled.get((at + 1) % enabled.len()),
        }),
        MenuKey::Previous => step_to(match position {
            None => enabled.last(),
            Some(at) => enabled.get((at + enabled.len() - 1) % enabled.len()),
        }),
        MenuKey::First => step_to(enabled.first()),
        MenuKey::Last => step_to(enabled.last()),
        MenuKey::Right => match highlighted.and_then(|row| items.get(row)) {
            Some(item) if item.enabled && item.submenu && !in_submenu => {
                MenuStep::OpenSubmenu(highlighted.unwrap_or_default())
            }
            _ => MenuStep::Ignored,
        },
        MenuKey::Left if in_submenu => MenuStep::CloseSubmenu,
        MenuKey::Left => MenuStep::Ignored,
        MenuKey::Activate => {
            match highlighted.and_then(|row| items.get(row).map(|item| (row, item))) {
                Some((row, item)) if item.enabled && item.submenu && !in_submenu => {
                    MenuStep::OpenSubmenu(row)
                }
                Some((row, item)) if item.enabled => MenuStep::Activate(row),
                _ => MenuStep::Consumed,
            }
        }
        MenuKey::Escape if in_submenu => MenuStep::CloseSubmenu,
        MenuKey::Escape => MenuStep::Close,
        MenuKey::Tab => MenuStep::CloseForTab,
    }
}

/// The row a menu opened from the keyboard starts on: its first enabled action. A menu opened
/// with the pointer starts on none.
#[must_use]
pub fn first_enabled(items: &[MenuNavItem]) -> Option<usize> {
    items.iter().position(|item| item.enabled)
}

/// A key in the sidebar search box that works the results.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SearchKey {
    /// `ArrowDown`: highlight the next result, from the last to the first.
    Next,
    /// `ArrowUp`: highlight the previous result, from the first to the last.
    Previous,
    /// `Enter`: open the highlighted result.
    Open,
    /// `Escape`: clear the search.
    Clear,
}

/// What `key` does in the search box. `Escape` clears a search that has text, with results or
/// not; the other keys need results. Conn leaves the modifiers out of it.
#[must_use]
pub fn search_key(key: &str, searching: bool, results: usize) -> Option<SearchKey> {
    if key == "escape" && searching {
        return Some(SearchKey::Clear);
    }
    if results == 0 {
        return None;
    }
    match key {
        "down" => Some(SearchKey::Next),
        "up" => Some(SearchKey::Previous),
        "enter" => Some(SearchKey::Open),
        _ => None,
    }
}

/// The highlighted result. It follows its thread, so results that arrive late do not move it
/// under `Enter`; a thread that is not listed, and a new search, start at the top. None without
/// results (`activeSearchResultIndex`).
#[must_use]
pub fn search_highlight_index(keys: &[String], highlight: Option<&str>) -> Option<usize> {
    if keys.is_empty() {
        return None;
    }
    Some(
        highlight
            .and_then(|key| keys.iter().position(|k| k == key))
            .unwrap_or(0),
    )
}

/// The result `ArrowDown` or `ArrowUp` highlights, wrapping at both ends (`moveSearchHighlight`).
/// `active` is the highlighted index from [`search_highlight_index`].
#[must_use]
pub fn search_step(count: usize, active: usize, key: SearchKey) -> usize {
    if count == 0 {
        return 0;
    }
    match key {
        SearchKey::Next => (active + 1) % count,
        SearchKey::Previous => (active + count - 1) % count,
        SearchKey::Open | SearchKey::Clear => active.min(count - 1),
    }
}

/// `thread.previous` and `thread.next`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThreadStep {
    Previous,
    Next,
}

/// The thread traversal `key` is: `⌘⇧[` and `⌘⇧]`, Conn's defaults (`mod+shift+[`, `mod+shift+]`
/// in `packages/shared/src/keybindings.ts`). The shifted characters count too, as a keyboard may
/// report either.
#[must_use]
pub fn thread_traversal_key(key: &str, mods: KeyMods) -> Option<ThreadStep> {
    if !(mods.platform && mods.shift && !mods.alt && !mods.control) {
        return None;
    }
    match key {
        "[" | "{" => Some(ThreadStep::Previous),
        "]" | "}" => Some(ThreadStep::Next),
        _ => None,
    }
}

/// The threads traversal walks, in sidebar order: pinned, active, then the settled threads the
/// shelf shows. A collapsed shelf shows only the open thread (`orderedThreads`,
/// `renderedSettledThreads`, `routeThreadOnly`). Drafts and the search results are not in it.
#[must_use]
pub fn traversal_order(
    pinned: &[&str],
    active: &[&str],
    settled: &[&str],
    settled_open: bool,
    open_thread: Option<&str>,
) -> Vec<String> {
    pinned
        .iter()
        .chain(active)
        .chain(
            settled
                .iter()
                .filter(|id| settled_open || Some(**id) == open_thread),
        )
        .map(|id| (*id).to_owned())
        .collect()
}

/// The thread `⌘⇧[` or `⌘⇧]` opens (`resolveAdjacentThreadId`). It stops at the ends, with no
/// wrap. With no thread open, `previous` goes to the last and `next` to the first; an open thread
/// that is not listed goes nowhere.
#[must_use]
pub fn adjacent_thread<'a>(
    ids: &'a [String],
    current: Option<&str>,
    step: ThreadStep,
) -> Option<&'a str> {
    let Some(current) = current else {
        return match step {
            ThreadStep::Previous => ids.last(),
            ThreadStep::Next => ids.first(),
        }
        .map(String::as_str);
    };
    let at = ids.iter().position(|id| id == current)?;
    match step {
        ThreadStep::Previous => at.checked_sub(1).and_then(|i| ids.get(i)),
        ThreadStep::Next => ids.get(at + 1),
    }
    .map(String::as_str)
}

/// How many threads `⌘1`..`⌘9` reach (`THREAD_JUMP_KEYBINDING_COMMANDS`).
pub const THREAD_JUMP_COUNT: usize = 9;

/// How long `⌘` is held before the numbers show on the rows (`THREAD_JUMP_HINT_SHOW_DELAY_MS`).
pub const THREAD_JUMP_HINT_DELAY_MS: u64 = 200;

/// The place `⌘1`..`⌘9` jump to, counting from 0 (`thread.jump.1`..`thread.jump.9`, Conn's
/// `mod+1`..`mod+9`). Any other modifier leaves the key alone.
#[must_use]
pub fn thread_jump_key(key: &str, mods: KeyMods) -> Option<usize> {
    if !(mods.platform && !mods.shift && !mods.alt && !mods.control) {
        return None;
    }
    let mut chars = key.chars();
    let digit = chars.next()?.to_digit(10)?;
    if chars.next().is_some() || digit == 0 {
        return None;
    }
    Some(usize::try_from(digit).ok()? - 1)
}

/// The thread `⌘1`..`⌘9` open: the one at that place of the order traversal walks
/// (`orderedThreadKeys[jumpIndex]`).
#[must_use]
pub fn jump_target(ids: &[String], index: usize) -> Option<&str> {
    if index >= THREAD_JUMP_COUNT {
        return None;
    }
    ids.get(index).map(String::as_str)
}

/// The number the jump hint on `thread`'s row shows, from 1 (`jumpLabelByKey`): only the first
/// nine threads of the order have one.
#[must_use]
pub fn jump_hint_number(ids: &[String], thread: &str) -> Option<usize> {
    ids.iter()
        .take(THREAD_JUMP_COUNT)
        .position(|id| id == thread)
        .map(|at| at + 1)
}

/// Whether the modifiers held are the jump shortcut's, so the hints may show
/// (`shouldShowThreadJumpHintsForModifiers`).
#[must_use]
pub fn shows_jump_hints(mods: KeyMods) -> bool {
    mods.platform && !mods.shift && !mods.alt && !mods.control
}

/// The hint on a row (`⌘3`): the jump shortcut's label.
#[must_use]
pub fn jump_hint_label(number: usize) -> String {
    format!("⌘{number}")
}

/// [`search_key`] for a search box that may be composing text with an input method: a key typed
/// during composition belongs to the input method (`isComposing`), so the results do not see it.
#[must_use]
pub fn search_key_unless_composing(
    key: &str,
    searching: bool,
    results: usize,
    composing: bool,
) -> Option<SearchKey> {
    if composing {
        return None;
    }
    search_key(key, searching, results)
}

/// What a click on a thread row does (`handleThreadClick`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowClick {
    /// Open the thread.
    Open,
    /// `⌘`-click: add the row to the selection or take it out.
    Toggle,
    /// `Shift`-click: select every row between the anchor and this one.
    Range,
}

/// The click a press with `mods` is. `⌘` wins over `Shift`.
#[must_use]
pub fn row_click(mods: KeyMods) -> RowClick {
    if mods.platform {
        RowClick::Toggle
    } else if mods.shift {
        RowClick::Range
    } else {
        RowClick::Open
    }
}

/// The threads picked for a bulk action (`useThreadSelectionStore`), in the order they were
/// picked, and the one a `Shift`-click counts from.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ThreadSelection {
    keys: Vec<String>,
    anchor: Option<String>,
}

impl ThreadSelection {
    /// Whether nothing is selected.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    /// Whether `key` is selected.
    #[must_use]
    pub fn contains(&self, key: &str) -> bool {
        self.keys.iter().any(|selected| selected == key)
    }

    /// The selected threads, in the order they were picked.
    #[must_use]
    pub fn keys(&self) -> &[String] {
        &self.keys
    }

    /// `toggleThread`: a thread that joins becomes the anchor; one that leaves keeps the old one.
    pub fn toggle(&mut self, key: &str) {
        if let Some(at) = self.keys.iter().position(|selected| selected == key) {
            self.keys.remove(at);
        } else {
            self.keys.push(key.to_owned());
            self.anchor = Some(key.to_owned());
        }
    }

    /// `rangeSelectTo`: every thread of `order` from the anchor to `key` joins. With no anchor, or
    /// one that `order` does not list, only `key` joins and becomes the anchor.
    pub fn range_select_to(&mut self, key: &str, order: &[String]) {
        let span = self.anchor.as_deref().and_then(|anchor| {
            let from = order.iter().position(|id| id == anchor)?;
            let to = order.iter().position(|id| id == key)?;
            Some(from.min(to)..=from.max(to))
        });
        match span {
            Some(span) => {
                for id in &order[span] {
                    if !self.contains(id) {
                        self.keys.push(id.clone());
                    }
                }
            }
            None => {
                if !self.contains(key) {
                    self.keys.push(key.to_owned());
                }
                self.anchor = Some(key.to_owned());
            }
        }
    }

    /// `setAnchor`: opening a thread makes it the place a `Shift`-click counts from.
    pub fn set_anchor(&mut self, key: &str) {
        self.anchor = Some(key.to_owned());
    }

    /// `clearSelection`. Returns whether the selection or its anchor changed.
    pub fn clear(&mut self) -> bool {
        let changed = !self.keys.is_empty() || self.anchor.is_some();
        self.keys.clear();
        self.anchor = None;
        changed
    }

    /// `removeFromSelection`: a deleted thread leaves, and takes the anchor with it.
    pub fn remove(&mut self, gone: &[String]) {
        self.keys.retain(|key| !gone.contains(key));
        if self
            .anchor
            .as_ref()
            .is_some_and(|anchor| gone.contains(anchor))
        {
            self.anchor = None;
        }
    }

    /// The selected threads that are still listed, in the order they were picked.
    #[must_use]
    pub fn listed(&self, order: &[String]) -> Vec<String> {
        self.keys
            .iter()
            .filter(|key| order.contains(key))
            .cloned()
            .collect()
    }
}

/// What a bulk action does to every selected thread.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BulkAction {
    Unpin,
    Settle,
    RegenerateTitles,
    MarkUnread,
    Delete,
}

/// What the threads picked for a bulk menu are like.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BulkFacts {
    /// Threads selected.
    pub selected: usize,
    /// Of them, pinned.
    pub pinned: usize,
    /// Of them, not settled yet.
    pub settling: usize,
    /// Of them, having a title regenerated right now.
    pub regenerating: usize,
}

/// One row of the bulk menu.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BulkEntry {
    pub action: BulkAction,
    pub label: String,
    pub disabled: bool,
    pub destructive: bool,
}

/// The menu a right-click on a selected row opens (`handleMultiSelectContextMenu`):
/// `Unpin (N)` when any is pinned, `Settle (N)`, `Regenerate titles (N)`, `Mark unread (N)` and a
/// destructive `Delete (N)`. `Settle` counts the whole selection and is off when every thread is
/// settled already. Snooze is left out with the rest of Snooze (`docs/scope.md` #9).
#[must_use]
pub fn bulk_menu(facts: BulkFacts) -> Vec<BulkEntry> {
    let entry = |action, label: String, disabled, destructive| BulkEntry {
        action,
        label,
        disabled,
        destructive,
    };
    let count = facts.selected;
    let mut items = Vec::with_capacity(5);
    if facts.pinned > 0 {
        items.push(entry(
            BulkAction::Unpin,
            format!("Unpin ({})", facts.pinned),
            false,
            false,
        ));
    }
    items.push(entry(
        BulkAction::Settle,
        format!("Settle ({count})"),
        facts.settling == 0,
        false,
    ));
    let actionable = count.saturating_sub(facts.regenerating);
    if count > 0 {
        items.push(if actionable == 0 {
            entry(
                BulkAction::RegenerateTitles,
                format!("Regenerating… ({count})"),
                true,
                false,
            )
        } else {
            entry(
                BulkAction::RegenerateTitles,
                format!("Regenerate titles ({actionable})"),
                false,
                false,
            )
        });
    }
    items.push(entry(
        BulkAction::MarkUnread,
        format!("Mark unread ({count})"),
        false,
        false,
    ));
    items.push(entry(
        BulkAction::Delete,
        format!("Delete ({count})"),
        false,
        true,
    ));
    items
}

/// The thread a settle of the open thread moves on to (`planForwardNavigation`): the next listed
/// thread after it, wrapping, that is neither settled nor settling along with it. None when no
/// thread is left, and a new thread starts instead.
#[must_use]
pub fn next_after_settle<'a>(
    order: &'a [String],
    open: &str,
    is_parked: impl Fn(&str) -> bool,
) -> Option<&'a str> {
    let at = order.iter().position(|id| id == open)?;
    order[at + 1..]
        .iter()
        .chain(&order[..at])
        .map(String::as_str)
        .find(|id| !is_parked(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command() -> KeyMods {
        KeyMods {
            platform: true,
            ..KeyMods::default()
        }
    }

    #[test]
    fn command_digits_jump_and_nothing_else_does() {
        assert_eq!(thread_jump_key("1", command()), Some(0));
        assert_eq!(thread_jump_key("9", command()), Some(8));
        assert_eq!(thread_jump_key("0", command()), None, "there is no ⌘0 jump");
        assert_eq!(thread_jump_key("a", command()), None);
        assert_eq!(thread_jump_key("12", command()), None);
        assert_eq!(thread_jump_key("1", KeyMods::default()), None, "a digit");
        for other in [
            KeyMods {
                shift: true,
                ..command()
            },
            KeyMods {
                alt: true,
                ..command()
            },
            KeyMods {
                control: true,
                ..command()
            },
        ] {
            assert_eq!(thread_jump_key("1", other), None, "{other:?}");
        }
    }

    #[test]
    fn a_jump_lands_on_the_place_in_the_traversal_order_and_misses_past_the_end() {
        let order = ids(&["a", "b", "c"]);
        assert_eq!(jump_target(&order, 0), Some("a"));
        assert_eq!(jump_target(&order, 2), Some("c"));
        assert_eq!(jump_target(&order, 3), None, "no fourth thread");
        let long: Vec<String> = (0..12).map(|n| format!("t{n}")).collect();
        assert_eq!(jump_target(&long, 8), Some("t8"));
        assert_eq!(jump_target(&long, 9), None, "only nine places are bound");
    }

    #[test]
    fn only_the_first_nine_threads_carry_a_hint() {
        let long: Vec<String> = (0..12).map(|n| format!("t{n}")).collect();
        assert_eq!(jump_hint_number(&long, "t0"), Some(1));
        assert_eq!(jump_hint_number(&long, "t8"), Some(9));
        assert_eq!(jump_hint_number(&long, "t9"), None);
        assert_eq!(jump_hint_number(&long, "gone"), None);
        assert_eq!(jump_hint_label(3), "⌘3");
        assert!(shows_jump_hints(command()));
        assert!(!shows_jump_hints(KeyMods::default()));
        assert!(
            !shows_jump_hints(KeyMods {
                shift: true,
                ..command()
            }),
            "⌘⇧ is another shortcut"
        );
    }

    #[test]
    fn a_search_key_typed_while_composing_belongs_to_the_input_method() {
        assert_eq!(
            search_key_unless_composing("enter", true, 3, true),
            None,
            "Enter commits the composition, it does not open a result"
        );
        assert_eq!(search_key_unless_composing("escape", true, 0, true), None);
        assert_eq!(
            search_key_unless_composing("enter", true, 3, false),
            Some(SearchKey::Open)
        );
        assert_eq!(
            search_key_unless_composing("escape", true, 0, false),
            Some(SearchKey::Clear)
        );
    }

    #[test]
    fn command_toggles_shift_ranges_and_command_wins() {
        assert_eq!(row_click(KeyMods::default()), RowClick::Open);
        assert_eq!(row_click(command()), RowClick::Toggle);
        assert_eq!(
            row_click(KeyMods {
                shift: true,
                ..KeyMods::default()
            }),
            RowClick::Range
        );
        assert_eq!(
            row_click(KeyMods {
                shift: true,
                ..command()
            }),
            RowClick::Toggle
        );
    }

    #[test]
    fn toggling_picks_and_unpicks_and_a_range_runs_from_the_anchor() {
        let order = ids(&["a", "b", "c", "d", "e"]);
        let mut selection = ThreadSelection::default();
        assert!(selection.is_empty());
        selection.toggle("b");
        selection.toggle("d");
        assert_eq!(
            selection.keys(),
            ["b", "d"],
            "in the order they were picked"
        );
        selection.toggle("d");
        assert!(!selection.contains("d"));
        // A thread that leaves keeps the anchor it was (`toggleThread`), so `d` still anchors.
        selection.range_select_to("e", &order);
        assert_eq!(selection.keys(), ["b", "d", "e"]);
        selection.range_select_to("a", &order);
        assert_eq!(
            selection.listed(&order),
            ["b", "d", "e", "a", "c"],
            "a range backwards adds the rows above the anchor, none twice"
        );
    }

    #[test]
    fn a_range_with_no_anchor_picks_one_thread_and_anchors_on_it() {
        let order = ids(&["a", "b", "c"]);
        let mut selection = ThreadSelection::default();
        selection.range_select_to("b", &order);
        assert_eq!(selection.keys(), ["b"]);
        selection.range_select_to("c", &order);
        assert_eq!(selection.keys(), ["b", "c"]);
        let mut lost = ThreadSelection::default();
        lost.set_anchor("gone");
        lost.range_select_to("c", &order);
        assert_eq!(lost.keys(), ["c"], "an anchor the list lost is replaced");
    }

    #[test]
    fn clearing_and_removing_end_the_selection_and_the_anchor() {
        let order = ids(&["a", "b", "c"]);
        let mut selection = ThreadSelection::default();
        assert!(!selection.clear(), "nothing to clear");
        selection.set_anchor("a");
        assert!(selection.clear(), "an anchor alone is cleared too");
        selection.toggle("a");
        selection.toggle("b");
        selection.remove(&ids(&["b"]));
        assert_eq!(selection.keys(), ["a"]);
        selection.range_select_to("c", &order);
        assert_eq!(
            selection.keys(),
            ["a", "c"],
            "the removed thread was the anchor, so the range is only the thread clicked"
        );
        assert_eq!(selection.listed(&ids(&["c"])), ["c"], "only listed threads");
        assert!(selection.clear());
        assert!(selection.is_empty());
    }

    #[test]
    fn the_bulk_menu_counts_what_each_action_reaches() {
        let menu = bulk_menu(BulkFacts {
            selected: 4,
            pinned: 2,
            settling: 3,
            regenerating: 1,
        });
        let labels: Vec<&str> = menu.iter().map(|entry| entry.label.as_str()).collect();
        assert_eq!(
            labels,
            [
                "Unpin (2)",
                "Settle (4)",
                "Regenerate titles (3)",
                "Mark unread (4)",
                "Delete (4)"
            ]
        );
        assert!(menu.iter().all(|entry| !entry.disabled));
        assert!(menu.last().is_some_and(|entry| entry.destructive));
    }

    #[test]
    fn the_bulk_menu_leaves_out_or_disables_what_does_not_apply() {
        let menu = bulk_menu(BulkFacts {
            selected: 2,
            pinned: 0,
            settling: 0,
            regenerating: 2,
        });
        let find = |action| menu.iter().find(|entry| entry.action == action);
        assert!(find(BulkAction::Unpin).is_none(), "nothing is pinned");
        let settle = find(BulkAction::Settle);
        assert!(settle.is_some_and(|entry| entry.disabled && entry.label == "Settle (2)"));
        let regenerate = find(BulkAction::RegenerateTitles);
        assert!(
            regenerate.is_some_and(|entry| entry.disabled && entry.label == "Regenerating… (2)")
        );
    }

    #[test]
    fn a_settle_moves_on_to_the_next_thread_that_stays_put() {
        let order = ids(&["a", "b", "c", "d"]);
        let parked = |id: &str| matches!(id, "c" | "d");
        assert_eq!(next_after_settle(&order, "b", parked), Some("a"), "wraps");
        assert_eq!(next_after_settle(&order, "a", parked), Some("b"));
        assert_eq!(
            next_after_settle(&order, "a", |_| true),
            None,
            "every other thread is settling too"
        );
        assert_eq!(next_after_settle(&order, "gone", |_| false), None);
    }

    fn rows() -> Vec<TreeRow> {
        vec![
            TreeRow::leaf(draft_tree_key("d1")),
            TreeRow::leaf("t1"),
            TreeRow::leaf("t2"),
            TreeRow::group(SETTLED_SHELF_ROW, false),
            TreeRow::child("s1", SETTLED_SHELF_ROW),
        ]
    }

    fn step(rows: &[TreeRow], current: &str, key: &str) -> Option<TreeStep> {
        tree_step(rows, current, tree_key(key, KeyMods::default())?)
    }

    fn focus(key: &str) -> Option<TreeStep> {
        Some(TreeStep::Focus(key.to_owned()))
    }

    #[test]
    fn arrows_move_between_rows_and_stop_at_the_ends() {
        let rows = rows();
        assert_eq!(step(&rows, "t1", "down"), focus("t2"));
        assert_eq!(step(&rows, "t1", "up"), focus("draft:d1"));
        assert_eq!(step(&rows, "draft:d1", "up"), focus("draft:d1"));
        assert_eq!(step(&rows, "s1", "down"), focus("s1"));
        assert_eq!(step(&rows, "t2", "home"), focus("draft:d1"));
        assert_eq!(step(&rows, "t1", "end"), focus("s1"));
    }

    #[test]
    fn a_row_that_is_not_listed_leaves_the_key_alone() {
        assert_eq!(step(&rows(), "gone", "down"), None);
        assert_eq!(step(&[], "t1", "down"), None);
    }

    #[test]
    fn a_modifier_leaves_the_key_to_others() {
        let shift = KeyMods {
            shift: true,
            ..KeyMods::default()
        };
        assert_eq!(tree_key("down", shift), None);
        let command = KeyMods {
            platform: true,
            ..KeyMods::default()
        };
        assert_eq!(tree_key("up", command), None);
        assert_eq!(tree_key("down", KeyMods::default()), Some(TreeKey::Next));
    }

    #[test]
    fn right_expands_a_collapsed_row_before_entering_it_and_left_goes_back() {
        let mut rows = rows();
        let toggle = Some(TreeStep::Toggle(SETTLED_SHELF_ROW.to_owned()));
        assert_eq!(step(&rows, SETTLED_SHELF_ROW, "right"), toggle);
        assert_eq!(step(&rows, SETTLED_SHELF_ROW, "left"), Some(TreeStep::Stay));

        rows[3] = TreeRow::group(SETTLED_SHELF_ROW, true);
        assert_eq!(step(&rows, SETTLED_SHELF_ROW, "right"), focus("s1"));
        assert_eq!(step(&rows, "s1", "left"), focus(SETTLED_SHELF_ROW));
        assert_eq!(step(&rows, SETTLED_SHELF_ROW, "left"), toggle);
    }

    #[test]
    fn right_and_left_on_a_plain_row_use_the_key_and_move_nowhere() {
        let rows = rows();
        assert_eq!(step(&rows, "t1", "right"), Some(TreeStep::Stay));
        assert_eq!(step(&rows, "t1", "left"), Some(TreeStep::Stay));
        assert_eq!(step(&rows, "s1", "right"), Some(TreeStep::Stay));
    }

    #[test]
    fn a_row_that_leaves_hands_the_keyboard_to_itself_its_parent_or_its_place() {
        let rows = rows();
        let lost = |key: &str| focused_row(&rows, key).expect("a listed row");
        assert_eq!(restore_target(&rows, &lost("t2")), Some("t2"));

        let without_s1: Vec<TreeRow> = rows.iter().filter(|r| r.key != "s1").cloned().collect();
        assert_eq!(
            restore_target(&without_s1, &lost("s1")),
            Some(SETTLED_SHELF_ROW),
            "a child follows its parent"
        );

        let without_t2: Vec<TreeRow> = rows.iter().filter(|r| r.key != "t2").cloned().collect();
        assert_eq!(
            restore_target(&without_t2, &lost("t2")),
            Some(SETTLED_SHELF_ROW),
            "a row with no parent takes the row now at its place"
        );

        let only_draft = vec![TreeRow::leaf("draft:d1")];
        assert_eq!(
            restore_target(&only_draft, &lost("s1")),
            Some("draft:d1"),
            "the place clamps to the last row"
        );
        assert_eq!(restore_target(&[], &lost("t1")), None);
    }

    #[test]
    fn row_keys_depend_on_the_kind_of_row() {
        let none = KeyMods::default();
        let shift = KeyMods {
            shift: true,
            ..none
        };
        let thread = row_kind("t1");
        let draft = row_kind("draft:d1");
        let shelf = row_kind("shelf:settled");
        assert_eq!(thread, RowKind::Thread("t1"));
        assert_eq!(draft, RowKind::Draft("d1"));
        assert_eq!(shelf, RowKind::Shelf("settled"));

        assert_eq!(row_key(thread, "enter", none), Some(RowKey::Activate));
        assert_eq!(row_key(thread, "space", none), Some(RowKey::Activate));
        assert_eq!(row_key(thread, "f2", none), Some(RowKey::Rename));
        assert_eq!(row_key(draft, "f2", none), None, "a draft has no title");
        assert_eq!(row_key(thread, "menu", none), Some(RowKey::Menu));
        assert_eq!(row_key(draft, "f10", shift), Some(RowKey::Menu));
        assert_eq!(row_key(thread, "f10", none), None);
        assert_eq!(row_key(shelf, "enter", none), Some(RowKey::Activate));
        assert_eq!(row_key(shelf, "f10", shift), None);
        assert_eq!(row_key(thread, "a", none), None);
    }

    fn item(enabled: bool, submenu: bool) -> MenuNavItem {
        MenuNavItem { enabled, submenu }
    }

    fn menu() -> Vec<MenuNavItem> {
        // pin, settle, rename (disabled), copy >, delete
        vec![
            item(true, false),
            item(true, false),
            item(false, false),
            item(true, true),
            item(true, false),
        ]
    }

    #[test]
    fn up_and_down_wrap_over_the_enabled_rows() {
        let items = menu();
        let go = |at, key| menu_step(&items, at, false, key);
        assert_eq!(go(Some(1), MenuKey::Next), MenuStep::Highlight(3));
        assert_eq!(go(Some(4), MenuKey::Next), MenuStep::Highlight(0));
        assert_eq!(go(Some(0), MenuKey::Previous), MenuStep::Highlight(4));
        assert_eq!(go(Some(3), MenuKey::Previous), MenuStep::Highlight(1));
        assert_eq!(go(None, MenuKey::Next), MenuStep::Highlight(0));
        assert_eq!(go(None, MenuKey::Previous), MenuStep::Highlight(4));
        assert_eq!(go(Some(3), MenuKey::First), MenuStep::Highlight(0));
        assert_eq!(go(Some(0), MenuKey::Last), MenuStep::Highlight(4));
        assert_eq!(
            menu_step(&[item(false, false)], None, false, MenuKey::Next),
            MenuStep::Consumed,
            "a menu with nothing enabled uses the key and stays put"
        );
    }

    #[test]
    fn right_opens_a_submenu_and_left_or_escape_close_one_level_at_a_time() {
        let items = menu();
        assert_eq!(
            menu_step(&items, Some(3), false, MenuKey::Right),
            MenuStep::OpenSubmenu(3)
        );
        assert_eq!(
            menu_step(&items, Some(3), false, MenuKey::Activate),
            MenuStep::OpenSubmenu(3)
        );
        assert_eq!(
            menu_step(&items, Some(0), false, MenuKey::Right),
            MenuStep::Ignored
        );
        assert_eq!(
            menu_step(&items, Some(0), false, MenuKey::Left),
            MenuStep::Ignored,
            "left does nothing in the first level"
        );
        assert_eq!(
            menu_step(&items, Some(0), true, MenuKey::Left),
            MenuStep::CloseSubmenu
        );
        assert_eq!(
            menu_step(&items, Some(0), true, MenuKey::Escape),
            MenuStep::CloseSubmenu
        );
        assert_eq!(
            menu_step(&items, Some(0), false, MenuKey::Escape),
            MenuStep::Close
        );
        assert_eq!(
            menu_step(&items, Some(0), false, MenuKey::Tab),
            MenuStep::CloseForTab
        );
    }

    #[test]
    fn enter_runs_the_highlighted_row_and_does_nothing_without_one() {
        let items = menu();
        assert_eq!(
            menu_step(&items, Some(1), false, MenuKey::Activate),
            MenuStep::Activate(1)
        );
        assert_eq!(
            menu_step(&items, None, false, MenuKey::Activate),
            MenuStep::Consumed
        );
        assert_eq!(
            menu_step(&items, Some(2), false, MenuKey::Activate),
            MenuStep::Consumed,
            "a disabled row does not run"
        );
    }

    #[test]
    fn a_menu_opened_from_the_keyboard_starts_on_its_first_action() {
        assert_eq!(first_enabled(&menu()), Some(0));
        assert_eq!(
            first_enabled(&[item(false, false), item(true, false)]),
            Some(1)
        );
        assert_eq!(first_enabled(&[item(false, true)]), None);
    }

    #[test]
    fn menu_keys_ignore_command_chords() {
        let command = KeyMods {
            platform: true,
            ..KeyMods::default()
        };
        assert_eq!(menu_key("down", command), None);
        assert_eq!(menu_key("down", KeyMods::default()), Some(MenuKey::Next));
        assert_eq!(
            menu_key("space", KeyMods::default()),
            Some(MenuKey::Activate)
        );
        assert_eq!(menu_key("x", KeyMods::default()), None);
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|id| (*id).to_owned()).collect()
    }

    #[test]
    fn the_search_box_works_the_results_with_arrows_and_enter() {
        assert_eq!(search_key("down", true, 3), Some(SearchKey::Next));
        assert_eq!(search_key("up", true, 3), Some(SearchKey::Previous));
        assert_eq!(search_key("enter", true, 3), Some(SearchKey::Open));
        assert_eq!(
            search_key("down", true, 0),
            None,
            "no results, no highlight"
        );
        assert_eq!(search_key("enter", true, 0), None);
        assert_eq!(search_key("left", true, 3), None);
    }

    #[test]
    fn escape_clears_a_search_that_has_text_with_results_or_not() {
        assert_eq!(search_key("escape", true, 0), Some(SearchKey::Clear));
        assert_eq!(search_key("escape", true, 3), Some(SearchKey::Clear));
        assert_eq!(
            search_key("escape", false, 0),
            None,
            "an empty box leaves it alone"
        );
    }

    #[test]
    fn the_highlight_follows_its_thread_and_wraps_at_both_ends() {
        let keys = ids(&["a", "b", "c"]);
        assert_eq!(search_highlight_index(&keys, None), Some(0));
        assert_eq!(search_highlight_index(&keys, Some("c")), Some(2));
        assert_eq!(
            search_highlight_index(&keys, Some("gone")),
            Some(0),
            "a thread that left the results starts over at the top"
        );
        assert_eq!(search_highlight_index(&[], Some("a")), None);
        assert_eq!(search_step(3, 2, SearchKey::Next), 0);
        assert_eq!(search_step(3, 0, SearchKey::Previous), 2);
        assert_eq!(search_step(3, 1, SearchKey::Next), 2);
        assert_eq!(search_step(1, 0, SearchKey::Next), 0);
        assert_eq!(search_step(0, 0, SearchKey::Next), 0);
    }

    #[test]
    fn command_shift_brackets_are_thread_traversal() {
        let command_shift = KeyMods {
            platform: true,
            shift: true,
            ..KeyMods::default()
        };
        assert_eq!(
            thread_traversal_key("[", command_shift),
            Some(ThreadStep::Previous)
        );
        assert_eq!(
            thread_traversal_key("{", command_shift),
            Some(ThreadStep::Previous)
        );
        assert_eq!(
            thread_traversal_key("]", command_shift),
            Some(ThreadStep::Next)
        );
        assert_eq!(
            thread_traversal_key("}", command_shift),
            Some(ThreadStep::Next)
        );
        for mods in [
            KeyMods::default(),
            KeyMods {
                platform: true,
                ..KeyMods::default()
            },
            KeyMods {
                shift: true,
                ..KeyMods::default()
            },
            KeyMods {
                alt: true,
                ..command_shift
            },
            KeyMods {
                control: true,
                ..command_shift
            },
        ] {
            assert_eq!(thread_traversal_key("]", mods), None, "{mods:?}");
        }
        assert_eq!(thread_traversal_key("a", command_shift), None);
    }

    #[test]
    fn traversal_stops_at_the_ends_and_starts_at_an_end_when_nothing_is_open() {
        let order = ids(&["p", "a", "b"]);
        let next = |current, step| adjacent_thread(&order, current, step);
        assert_eq!(next(Some("p"), ThreadStep::Next), Some("a"));
        assert_eq!(next(Some("a"), ThreadStep::Previous), Some("p"));
        assert_eq!(
            next(Some("b"), ThreadStep::Next),
            None,
            "no wrap at the end"
        );
        assert_eq!(
            next(Some("p"), ThreadStep::Previous),
            None,
            "no wrap at the start"
        );
        assert_eq!(next(None, ThreadStep::Next), Some("p"));
        assert_eq!(next(None, ThreadStep::Previous), Some("b"));
        assert_eq!(
            next(Some("gone"), ThreadStep::Next),
            None,
            "an unlisted thread goes nowhere"
        );
        assert_eq!(adjacent_thread(&[], None, ThreadStep::Next), None);
    }

    #[test]
    fn traversal_walks_what_the_sidebar_shows() {
        let walk = |shelf, open_thread| {
            traversal_order(&["p"], &["a", "b"], &["s1", "s2"], shelf, open_thread).concat()
        };
        assert_eq!(
            walk(true, None),
            "pabs1s2",
            "an open shelf lists every settled thread"
        );
        assert_eq!(walk(false, None), "pab", "a collapsed shelf lists none");
        assert_eq!(
            walk(false, Some("s2")),
            "pabs2",
            "a collapsed shelf still shows the open settled thread"
        );
    }
}
