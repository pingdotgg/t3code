//! The Settled shelf's paging and its kept state (`Sidebar.tsx` `useSidebarThreads`,
//! `SETTLED_TAIL_*`, `SETTLED_SHELF_EXPANDED_KEY`): how many rows it shows, which rows, what its
//! header counts and what its footer says. Plain data in and out, so the iPhone app can share it.

use serde_json::{Value, json};

/// Key of the shelf's `Show more` row (`data-sidebar-row="settled:more"`).
pub const SETTLED_MORE_ROW: &str = "shelf:settled:more";

/// `SETTLED_TAIL_INITIAL_COUNT`: rows shown when the shelf opens.
pub const SETTLED_TAIL_INITIAL_COUNT: usize = 10;
/// `SETTLED_TAIL_PAGE_COUNT`: rows one `Show more` adds.
pub const SETTLED_TAIL_PAGE_COUNT: usize = 25;

/// How many rows the shelf shows. A new project scope starts over.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettledTail {
    scope_key: String,
    count: usize,
}

impl Default for SettledTail {
    fn default() -> Self {
        Self {
            scope_key: String::new(),
            count: SETTLED_TAIL_INITIAL_COUNT,
        }
    }
}

impl SettledTail {
    /// Rows shown under `scope_key`; a scope the tail has not seen starts at the first page.
    pub fn count_for(&mut self, scope_key: &str) -> usize {
        if self.scope_key != scope_key {
            self.scope_key = scope_key.to_owned();
            self.count = SETTLED_TAIL_INITIAL_COUNT;
        }
        self.count
    }

    /// Rows shown under `scope_key`, without starting the scope (for readers that cannot mutate).
    #[must_use]
    pub fn count_in(&self, scope_key: &str) -> usize {
        if self.scope_key == scope_key {
            self.count
        } else {
            SETTLED_TAIL_INITIAL_COUNT
        }
    }

    /// `showMoreSettled`.
    pub fn show_more(&mut self) {
        self.count += SETTLED_TAIL_PAGE_COUNT;
    }
}

/// What the shelf is asked to show.
#[derive(Clone, Copy, Debug)]
pub struct ShelfInput<'a> {
    /// The rows the shelf may list (at or above its frontier), newest settle first.
    pub listed: &'a [String],
    /// Every settled thread the client holds in scope, listed or not, in any order.
    pub held: &'a [String],
    /// Older settled threads the client does not hold (`unloadedOlderSettled`).
    pub unloaded: usize,
    /// The open thread's row (`routeRowThreadKey`).
    pub open: Option<&'a str>,
    pub expanded: bool,
    /// Rows the shelf shows when open (`settledVisibleCount`).
    pub visible_count: usize,
}

/// The shelf as drawn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShelfView {
    /// The rows to draw, in order.
    pub rows: Vec<String>,
    /// The number in the header: every settled thread in scope, loaded or not.
    pub count: usize,
    /// Settled threads in scope that no row shows yet.
    pub hidden: usize,
}

impl ShelfView {
    /// Whether the footer offers `Show more`.
    #[must_use]
    pub fn has_more(&self, expanded: bool) -> bool {
        expanded && self.hidden > 0
    }
}

/// `visibleSettledThreads`, `renderedSettledThreads` and the counts around them.
#[must_use]
pub fn shelf_view(input: &ShelfInput<'_>) -> ShelfView {
    let mut shown: Vec<&String> = input.listed.iter().take(input.visible_count).collect();
    // The open thread stays in view even when it is past the rows shown.
    if let Some(open) = input.open
        && !shown.iter().any(|id| id.as_str() == open)
        && let Some(held) = input.held.iter().find(|id| id.as_str() == open)
    {
        shown.push(held);
    }
    let count = input.held.len() + input.unloaded;
    let hidden = count.saturating_sub(shown.len());
    // A closed shelf keeps only the open thread (`routeThreadOnly`).
    let rows = if input.expanded {
        shown.into_iter().cloned().collect()
    } else {
        shown
            .into_iter()
            .filter(|id| Some(id.as_str()) == input.open)
            .cloned()
            .collect()
    };
    ShelfView {
        rows,
        count,
        hidden,
    }
}

/// What the footer button says (`Show more` on the shelf).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MoreState {
    Idle,
    Loading,
    Failed,
}

/// The footer button's text.
#[must_use]
pub fn more_label(state: MoreState, hidden: usize) -> String {
    match state {
        MoreState::Loading => "Loading".to_owned(),
        MoreState::Failed => "Could not load older threads. Retry".to_owned(),
        MoreState::Idle => format!("Show {} more", hidden.min(SETTLED_TAIL_PAGE_COUNT)),
    }
}

/// What the sidebar remembers between launches (`SETTLED_SHELF_EXPANDED_KEY`, and the widths
/// Conn keeps under `chat_thread_sidebar_width` and `t3code:preview-panel-width`). Conn keeps
/// them in local storage; this client keeps a small file.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SidebarPrefs {
    pub settled_expanded: bool,
    /// The width the user dragged the thread sidebar to; none until they do.
    pub sidebar_width: Option<f32>,
    /// The width the user dragged the right panel to; none until they do.
    pub right_panel_width: Option<f32>,
}

fn width_of(value: &Value) -> Option<f32> {
    // `Schema.Finite`: a stored width that is not a finite number is not one.
    #[expect(
        clippy::cast_possible_truncation,
        reason = "a panel width is a few hundred pixels"
    )]
    value.as_f64().map(|w| w as f32).filter(|w| w.is_finite())
}

impl SidebarPrefs {
    /// The file's text.
    #[must_use]
    pub fn to_json(self) -> String {
        let mut value = json!({ "settledExpanded": self.settled_expanded });
        if let Some(width) = self.sidebar_width {
            value["sidebarWidth"] = json!(width);
        }
        if let Some(width) = self.right_panel_width {
            value["rightPanelWidth"] = json!(width);
        }
        value.to_string()
    }

    /// The preferences in `text`; anything unreadable is the default (`useLocalStorage` falls
    /// back when a stored value does not decode).
    #[must_use]
    pub fn from_json(text: &str) -> Self {
        let value: Value = serde_json::from_str(text).unwrap_or(Value::Null);
        Self {
            settled_expanded: value["settledExpanded"].as_bool().unwrap_or(false),
            sidebar_width: width_of(&value["sidebarWidth"]),
            right_panel_width: width_of(&value["rightPanelWidth"]),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(count: usize) -> Vec<String> {
        (0..count).map(|n| format!("t{n}")).collect()
    }

    fn view(
        listed: &[String],
        unloaded: usize,
        open: Option<&str>,
        expanded: bool,
        visible: usize,
    ) -> ShelfView {
        shelf_view(&ShelfInput {
            listed,
            held: listed,
            unloaded,
            open,
            expanded,
            visible_count: visible,
        })
    }

    #[test]
    fn the_shelf_shows_a_page_and_counts_the_rest_as_hidden() {
        let listed = ids(12);
        let shown = view(&listed, 30, None, true, SETTLED_TAIL_INITIAL_COUNT);
        assert_eq!(shown.rows.len(), 10);
        assert_eq!(shown.count, 42);
        assert_eq!(shown.hidden, 32);
        assert!(shown.has_more(true));
        assert!(!shown.has_more(false));
    }

    #[test]
    fn a_closed_shelf_keeps_only_the_open_thread_even_past_the_rows_shown() {
        let listed = ids(12);
        let closed = view(&listed, 0, Some("t11"), false, SETTLED_TAIL_INITIAL_COUNT);
        assert_eq!(closed.rows, ["t11"]);
        assert_eq!(closed.count, 12);
        let none = view(
            &listed,
            0,
            Some("elsewhere"),
            false,
            SETTLED_TAIL_INITIAL_COUNT,
        );
        assert!(none.rows.is_empty());
        let open = view(&listed, 0, Some("t11"), true, SETTLED_TAIL_INITIAL_COUNT);
        assert_eq!(open.rows.len(), 11);
        assert_eq!(
            open.hidden, 1,
            "the open row is not counted as hidden twice"
        );
    }

    #[test]
    fn rows_below_the_frontier_count_but_are_not_listed() {
        let held = ids(5);
        let listed = held[..3].to_vec();
        let shown = shelf_view(&ShelfInput {
            listed: &listed,
            held: &held,
            unloaded: 0,
            open: None,
            expanded: true,
            visible_count: 10,
        });
        assert_eq!(shown.rows.len(), 3);
        assert_eq!(shown.count, 5);
        assert_eq!(shown.hidden, 2);
    }

    #[test]
    fn show_more_adds_a_page_and_a_new_scope_starts_over() {
        let mut tail = SettledTail::default();
        assert_eq!(tail.count_for("all"), 10);
        tail.show_more();
        assert_eq!(tail.count_for("all"), 35);
        assert_eq!(tail.count_for("project"), 10);
        assert_eq!(tail.count_for("all"), 10);
    }

    #[test]
    fn a_reader_sees_the_count_of_its_scope_without_starting_it() {
        let mut tail = SettledTail::default();
        tail.count_for("all");
        tail.show_more();
        assert_eq!(tail.count_in("all"), 35);
        assert_eq!(tail.count_in("project"), 10);
        assert_eq!(tail.count_in("all"), 35, "asking did not change the scope");
    }

    #[test]
    fn the_footer_says_what_it_does() {
        assert_eq!(more_label(MoreState::Idle, 100), "Show 25 more");
        assert_eq!(more_label(MoreState::Idle, 7), "Show 7 more");
        assert_eq!(more_label(MoreState::Loading, 7), "Loading");
        assert_eq!(
            more_label(MoreState::Failed, 7),
            "Could not load older threads. Retry"
        );
    }

    #[test]
    fn preferences_round_trip_and_bad_text_is_the_default() {
        let prefs = SidebarPrefs {
            settled_expanded: true,
            ..SidebarPrefs::default()
        };
        assert_eq!(SidebarPrefs::from_json(&prefs.to_json()), prefs);
        assert_eq!(SidebarPrefs::from_json("not json"), SidebarPrefs::default());
        assert_eq!(
            SidebarPrefs::from_json("{\"settledExpanded\": 3}"),
            SidebarPrefs::default()
        );
        assert!(!SidebarPrefs::default().settled_expanded);
    }

    #[test]
    fn the_widths_round_trip_and_an_unreadable_one_is_none() {
        let prefs = SidebarPrefs {
            settled_expanded: true,
            sidebar_width: Some(280.0),
            right_panel_width: Some(640.5),
        };
        assert_eq!(SidebarPrefs::from_json(&prefs.to_json()), prefs);
        assert_eq!(
            SidebarPrefs::from_json("{\"sidebarWidth\": \"wide\", \"rightPanelWidth\": null}"),
            SidebarPrefs::default()
        );
        // A file from before the widths holds none.
        assert_eq!(
            SidebarPrefs::from_json("{\"settledExpanded\": true}"),
            SidebarPrefs {
                settled_expanded: true,
                ..SidebarPrefs::default()
            }
        );
        assert_eq!(
            SidebarPrefs::default().to_json(),
            "{\"settledExpanded\":false}",
            "a width never chosen is not written"
        );
    }
}
