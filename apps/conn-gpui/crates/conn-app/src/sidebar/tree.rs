//! Keyboard focus of the thread sidebar's rows (Conn `lib/sidebarTree.ts`): one focus handle per
//! row, the rows in display order, and which row had the keyboard last. The order and the moves
//! come from `conn_state::sidebar_nav`; this file holds the focus handles and the scroll.

use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;

use conn_state::{FocusedRow, TreeRow, focused_row, restore_target};
use conn_theme::Tokens;
use gpui_kit::{
    App, Bounds, BoxShadow, FocusHandle, Pixels, Point, ScrollHandle, Window, point, px,
};

use crate::theme::hsla;

/// What a row needs to take the keyboard: its focus handle, and where it was last painted (for
/// a menu opened below it, and to scroll it into view).
#[derive(Clone)]
pub(crate) struct RowFocus {
    pub(crate) handle: FocusHandle,
    pub(crate) bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
}

/// `focus-visible:ring-2 ring-inset ring-ring`: the ring a keyboard-focused row shows.
#[must_use]
pub(crate) fn focus_ring(tokens: &Tokens) -> BoxShadow {
    BoxShadow {
        color: hsla(tokens.ring),
        offset: point(px(0.0), px(0.0)),
        blur_radius: px(0.0),
        spread_radius: px(2.0),
        inset: true,
    }
}

/// The sidebar rows the keyboard can reach. Rebuilt on every render of the sidebar.
pub(crate) struct SidebarTree {
    slots: HashMap<String, RowFocus>,
    rows: Vec<TreeRow>,
    /// Where the keyboard last was among the rows.
    last_focus: Option<FocusedRow>,
    scroll: ScrollHandle,
    /// Where the search results were last painted. They take no keyboard, so they are not rows,
    /// but the highlighted one scrolls into view.
    results: HashMap<String, Rc<Cell<Option<Bounds<Pixels>>>>>,
}

impl SidebarTree {
    pub(crate) fn new() -> Self {
        Self {
            slots: HashMap::new(),
            rows: Vec::new(),
            last_focus: None,
            scroll: ScrollHandle::new(),
            results: HashMap::new(),
        }
    }

    /// The list's scroll handle.
    pub(crate) fn scroll(&self) -> &ScrollHandle {
        &self.scroll
    }

    /// The rows in display order, as the last render drew them.
    pub(crate) fn rows(&self) -> &[TreeRow] {
        &self.rows
    }

    /// Starts a render: the rows are listed again, top to bottom, with [`Self::row`].
    pub(crate) fn begin(&mut self) {
        self.rows.clear();
        self.results.clear();
    }

    /// Where the search result `key` will be painted. A result is not a row: it takes no
    /// keyboard (`tabIndex={-1}`).
    pub(crate) fn result_bounds(&mut self, key: &str) -> Rc<Cell<Option<Bounds<Pixels>>>> {
        let bounds = Rc::new(Cell::new(None));
        self.results.insert(key.to_owned(), Rc::clone(&bounds));
        bounds
    }

    /// Lists `row` next in the display order and returns what it needs to take the keyboard.
    /// Every row is a tab stop, as Conn leaves them in the Tab order for screen readers.
    pub(crate) fn row(&mut self, row: TreeRow, cx: &mut App) -> RowFocus {
        let focus = match self.slots.get(&row.key) {
            Some(slot) => slot.clone(),
            None => {
                let slot = RowFocus {
                    handle: cx.focus_handle().tab_index(0).tab_stop(true),
                    bounds: Rc::new(Cell::new(None)),
                };
                self.slots.insert(row.key.clone(), slot.clone());
                slot
            }
        };
        self.rows.push(row);
        focus
    }

    /// Ends a render. Notes which row has the keyboard, forgets the rows that left, and when the
    /// focused row left returns the handle of the row that takes the keyboard (`restoreFocus`).
    /// A row that only moved keeps its handle, so it keeps the keyboard by itself.
    pub(crate) fn finish(&mut self, window: &Window) -> Option<FocusHandle> {
        let focused_now = self
            .rows
            .iter()
            .find(|row| {
                self.slots
                    .get(&row.key)
                    .is_some_and(|slot| slot.handle.is_focused(window))
            })
            .map(|row| row.key.clone());
        if let Some(key) = &focused_now {
            self.last_focus = focused_row(&self.rows, key);
        }
        if self.slots.len() == self.rows.len() {
            return None;
        }
        let listed: std::collections::HashSet<&str> =
            self.rows.iter().map(|row| row.key.as_str()).collect();
        let lost = focused_now.is_none()
            && self.slots.iter().any(|(key, slot)| {
                !listed.contains(key.as_str()) && slot.handle.is_focused(window)
            });
        let target = lost
            .then(|| {
                let lost = self.last_focus.as_ref()?;
                let key = restore_target(&self.rows, lost)?;
                self.slots.get(key).map(|slot| slot.handle.clone())
            })
            .flatten();
        self.slots.retain(|key, _| listed.contains(key.as_str()));
        target
    }

    /// The focus handle of the row `key`.
    pub(crate) fn handle(&self, key: &str) -> Option<&FocusHandle> {
        self.slots.get(key).map(|slot| &slot.handle)
    }

    /// Whether `handle` is the focus handle of one of the rows.
    pub(crate) fn owns(&self, handle: &FocusHandle) -> bool {
        self.slots.values().any(|slot| &slot.handle == handle)
    }

    /// Whether the row `key` itself has the keyboard (not one of its buttons).
    pub(crate) fn is_focused(&self, key: &str, window: &Window) -> bool {
        self.handle(key)
            .is_some_and(|handle| handle.is_focused(window))
    }

    /// Where the row `key` was last painted.
    pub(crate) fn bounds_of(&self, key: &str) -> Option<Bounds<Pixels>> {
        self.slots.get(key)?.bounds.get()
    }

    /// Where the open menu of the row `key` goes: its bottom-left corner.
    pub(crate) fn below(&self, key: &str) -> Option<Point<Pixels>> {
        let bounds = self.slots.get(key)?.bounds.get()?;
        Some(point(bounds.left(), bounds.bottom()))
    }

    /// Gives the keyboard to the row `key`, without opening it, and scrolls it into view.
    pub(crate) fn focus(&mut self, key: &str, window: &mut Window, cx: &mut App) {
        if let Some(slot) = self.slots.get(key) {
            self.reveal(slot);
        }
        self.take_focus(key, window, cx);
    }

    /// Gives the keyboard to the row `key` where it is. A row about to go (a discarded draft)
    /// hands it on to the row that takes its place, so the keyboard is never left on nothing.
    pub(crate) fn take_focus(&mut self, key: &str, window: &mut Window, cx: &mut App) {
        let Some(slot) = self.slots.get(key) else {
            return;
        };
        window.focus(&slot.handle, cx);
        self.last_focus = focused_row(&self.rows, key);
    }

    /// Scrolls the list the least that shows the row `key`, without moving the keyboard.
    pub(crate) fn reveal_row(&self, key: &str) {
        if let Some(slot) = self.slots.get(key) {
            self.reveal(slot);
        } else if let Some(bounds) = self.results.get(key) {
            self.reveal_bounds(bounds.get());
        }
    }

    /// Scrolls the list the least that shows `slot`'s row (`scrollIntoView({ block: "nearest" })`).
    fn reveal(&self, slot: &RowFocus) {
        self.reveal_bounds(slot.bounds.get());
    }

    fn reveal_bounds(&self, row: Option<Bounds<Pixels>>) {
        let (Some(row), container) = (row, self.scroll.bounds()) else {
            return;
        };
        if container.size.height <= px(0.0) {
            return;
        }
        let mut offset = self.scroll.offset();
        if row.top() < container.top() {
            offset.y += container.top() - row.top();
        } else if row.bottom() > container.bottom() {
            offset.y -= row.bottom() - container.bottom();
        } else {
            return;
        }
        self.scroll.set_offset(offset);
    }
}
