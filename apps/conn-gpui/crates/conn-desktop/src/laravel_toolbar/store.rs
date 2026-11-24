//! The Laravel Toolbar's per-tab request history (`apps/web/src/laravelToolbar/store.ts`): the
//! page's own request, the later fetch/XHR/Inertia requests, the payloads loaded so far and the
//! request picked in the Requests panel.

use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use super::model::{ToolbarData, ToolbarHistoryRow, row_from_data};

/// The newest requests a tab keeps. Each one can hold a full profiler payload.
pub const MAX_HISTORY: usize = 200;

/// A request in the history, and when the client saw it (the payload carries no timestamp).
#[derive(Debug, Clone, PartialEq)]
pub struct HistoryEntry {
    pub row: ToolbarHistoryRow,
    pub received_at: u64,
}

/// One tab's toolbar (`TabToolbar`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TabToolbar {
    /// The page's own request: the one the document was rendered by.
    pub current_id: Option<String>,
    pub history: Vec<HistoryEntry>,
    pub details: HashMap<String, ToolbarData>,
    /// A request picked in the Requests panel; none shows the current one.
    pub selected_id: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

fn upsert(history: &mut Vec<HistoryEntry>, row: ToolbarHistoryRow, now: u64) {
    match history.iter().position(|entry| entry.row.id == row.id) {
        Some(index) => {
            let received_at = history[index].received_at;
            history[index] = HistoryEntry { row, received_at };
        }
        None => history.push(HistoryEntry {
            row,
            received_at: now,
        }),
    }
}

fn rows_of(history: Option<&Value>) -> Option<Vec<ToolbarHistoryRow>> {
    Some(
        history?
            .as_array()?
            .iter()
            .filter_map(ToolbarHistoryRow::from_json)
            .collect(),
    )
}

fn has(data: &ToolbarData, key: &str) -> bool {
    data.get(key).is_some_and(|v| !v.is_null())
}

fn request_id(data: &ToolbarData) -> Option<&str> {
    data.get("request_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
}

impl TabToolbar {
    /// Keeps the newest [`MAX_HISTORY`] requests (always including the current one) and drops the
    /// payloads and selection of any request that is no longer in the history.
    fn trim(&mut self) {
        if self.history.len() > MAX_HISTORY {
            let cut = self.history.len() - MAX_HISTORY;
            let current = self.current_id.as_ref().and_then(|id| {
                (!self.history[cut..].iter().any(|e| &e.row.id == id))
                    .then(|| self.history.iter().find(|e| &e.row.id == id).cloned())
                    .flatten()
            });
            let mut kept: Vec<HistoryEntry> = self.history.split_off(cut);
            if let Some(current) = current {
                kept.remove(0);
                kept.insert(0, current);
            }
            self.history = kept;
        }
        let ids: HashSet<&str> = self.history.iter().map(|e| e.row.id.as_str()).collect();
        self.details.retain(|id, _| ids.contains(id.as_str()));
        if self
            .selected_id
            .as_deref()
            .is_some_and(|id| !ids.contains(id))
        {
            self.selected_id = None;
        }
    }

    /// A full page load: the toolbar starts over from the document's payload.
    pub fn receive_page(&mut self, data: ToolbarData) {
        let now = now_ms();
        let row = row_from_data(&data);
        let mut history: Vec<HistoryEntry> = rows_of(data.get("request_history"))
            .unwrap_or_default()
            .into_iter()
            .map(|row| HistoryEntry {
                row,
                received_at: now,
            })
            .collect();
        // The server's own history row is richer (follow-up marks); build one only when missing.
        if let Some(row) = &row
            && !history.iter().any(|e| e.row.id == row.id)
        {
            upsert(&mut history, row.clone(), now);
        }
        self.current_id = row.as_ref().map(|r| r.id.clone());
        self.history = history;
        self.details = row
            .map(|r| HashMap::from([(r.id, data)]))
            .unwrap_or_default();
        self.selected_id = None;
        self.trim();
    }

    /// A later request (fetch, XHR, Inertia visit): a full payload or a summary row.
    pub fn receive_update(&mut self, data: ToolbarData) {
        let now = now_ms();
        let full_id = (has(&data, "profiler"))
            .then(|| request_id(&data).map(str::to_owned))
            .flatten();
        // Like the page's own toolbar: a payload with `request_history` replaces the state. The
        // server sends one for Inertia visits, which make a new page in the same document.
        if let Some(rows) = rows_of(data.get("request_history")) {
            let seen: HashMap<String, u64> = self
                .history
                .iter()
                .map(|e| (e.row.id.clone(), e.received_at))
                .collect();
            self.current_id = data
                .get("selected_request_id")
                .and_then(Value::as_str)
                .or_else(|| request_id(&data))
                .map(str::to_owned)
                .or_else(|| self.current_id.take());
            self.history = rows
                .into_iter()
                .map(|row| {
                    let received_at = seen.get(&row.id).copied().unwrap_or(now);
                    HistoryEntry { row, received_at }
                })
                .collect();
            if let Some(id) = full_id {
                self.details.insert(id, data);
            }
            self.selected_id = None;
            self.trim();
            return;
        }
        let row = if has(&data, "profiler") {
            row_from_data(&data)
        } else {
            data.get("history_row")
                .and_then(ToolbarHistoryRow::from_json)
        };
        let Some(row) = row else {
            return;
        };
        upsert(&mut self.history, row, now);
        if let Some(id) = full_id {
            self.details.insert(id, data);
        }
        self.trim();
    }

    /// The full payload of a request loaded on demand.
    pub fn receive_details(&mut self, id: &str, data: ToolbarData) {
        self.details.insert(id.to_owned(), data);
        self.trim();
    }

    /// A request the client sent itself (the API panel): it becomes the current one and joins the
    /// history. `data` is the full payload, or none when only a summary row arrived.
    pub fn receive_request(&mut self, row: ToolbarHistoryRow, data: Option<ToolbarData>) {
        self.current_id = Some(row.id.clone());
        if let Some(data) = data {
            self.details.insert(row.id.clone(), data);
        }
        upsert(&mut self.history, row, now_ms());
        self.selected_id = None;
        self.trim();
    }

    /// Picks a request in the Requests panel; the current one is no selection.
    pub fn select(&mut self, id: Option<&str>) {
        self.selected_id = id
            .filter(|id| Some(*id) != self.current_id.as_deref())
            .map(str::to_owned);
        self.trim();
    }

    /// Clears the history but the current request.
    pub fn clear_history(&mut self) {
        let current = self.current_id.clone();
        self.history.retain(|e| Some(&e.row.id) == current.as_ref());
        self.selected_id = None;
        self.trim();
    }

    /// The request the panels show: the picked one, else the current one.
    #[must_use]
    pub fn shown_id(&self) -> Option<&str> {
        self.selected_id.as_deref().or(self.current_id.as_deref())
    }

    /// The payload of the request the panels show, when loaded.
    #[must_use]
    pub fn shown_data(&self) -> Option<&ToolbarData> {
        self.details.get(self.shown_id()?)
    }

    /// The history row of the request the panels show.
    #[must_use]
    pub fn shown_row(&self) -> Option<&ToolbarHistoryRow> {
        let id = self.shown_id()?;
        self.history.iter().find(|e| e.row.id == id).map(|e| &e.row)
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.history.is_empty() && self.current_id.is_none()
    }
}

/// The toolbars of every tab, by tab id (`useLaravelToolbarStore`).
#[derive(Debug, Clone, Default)]
pub struct ToolbarStore {
    tabs: HashMap<String, TabToolbar>,
}

impl ToolbarStore {
    #[must_use]
    pub fn tab(&self, tab_id: &str) -> Option<&TabToolbar> {
        self.tabs.get(tab_id)
    }

    pub fn tab_mut(&mut self, tab_id: &str) -> &mut TabToolbar {
        self.tabs.entry(tab_id.to_owned()).or_default()
    }

    /// The page left Laravel or reloaded without the toolbar.
    pub fn forget(&mut self, tab_id: &str) -> bool {
        self.tabs.remove(tab_id).is_some()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn data(value: Value) -> ToolbarData {
        match value {
            Value::Object(map) => map,
            _ => ToolbarData::new(),
        }
    }

    fn row(id: &str, uri: &str) -> ToolbarHistoryRow {
        ToolbarHistoryRow::from_json(&json!({ "id": id, "method": "GET", "uri": uri }))
            .expect("a row")
    }

    fn ids(tab: &TabToolbar) -> Vec<&str> {
        tab.history.iter().map(|e| e.row.id.as_str()).collect()
    }

    fn sorted_details(tab: &TabToolbar) -> Vec<String> {
        let mut keys: Vec<String> = tab.details.keys().cloned().collect();
        keys.sort();
        keys
    }

    #[test]
    fn starts_over_on_a_page_load() {
        let mut tab = TabToolbar::default();
        tab.receive_page(data(json!({ "request_id": "r1", "profiler": { "stages": [] }, "request": { "method": "GET", "uri": "/" } })));
        assert_eq!(tab.current_id.as_deref(), Some("r1"));
        assert_eq!(ids(&tab), ["r1"]);
    }

    #[test]
    fn keeps_the_servers_row_for_the_page_with_its_follow_up_mark() {
        let mut tab = TabToolbar::default();
        tab.receive_page(data(json!({
            "request_id": "r2", "profiler": {},
            "request_history": [
                { "id": "r1", "method": "GET", "uri": "/old", "status_code": 302 },
                { "id": "r2", "method": "GET", "uri": "/new", "follow_up": "redirect" }
            ]
        })));
        let marks: Vec<Option<&str>> = tab
            .history
            .iter()
            .map(|e| e.row.follow_up.as_deref())
            .collect();
        assert_eq!(marks, [None, Some("redirect")]);
    }

    #[test]
    fn adds_a_summary_row_for_a_later_request() {
        let mut tab = TabToolbar::default();
        tab.receive_page(data(json!({ "request_id": "r1", "profiler": {} })));
        tab.receive_update(data(json!({ "request_id": "r2", "history_row": { "id": "r2", "method": "GET", "uri": "/api" } })));
        assert_eq!(ids(&tab), ["r1", "r2"]);
        assert_eq!(tab.current_id.as_deref(), Some("r1"));
    }

    #[test]
    fn replaces_the_state_when_an_inertia_visit_sends_the_history() {
        let mut tab = TabToolbar::default();
        tab.receive_page(data(json!({ "request_id": "r1", "profiler": {} })));
        tab.receive_update(data(json!({
            "request_id": "r3", "selected_request_id": "r3",
            "request_history": [ { "id": "r1", "method": "GET", "uri": "/" }, { "id": "r3", "method": "GET", "uri": "/download" } ]
        })));
        assert_eq!(tab.current_id.as_deref(), Some("r3"));
        assert_eq!(ids(&tab), ["r1", "r3"]);
    }

    #[test]
    fn makes_a_request_sent_from_the_api_panel_current_and_keeps_the_earlier_ones() {
        let mut tab = TabToolbar::default();
        tab.receive_request(
            row("a", "/api/users"),
            Some(data(json!({ "request_id": "a" }))),
        );
        tab.receive_request(row("b", "/api/users"), None);
        assert_eq!(tab.current_id.as_deref(), Some("b"));
        assert_eq!(ids(&tab), ["a", "b"]);
        assert_eq!(sorted_details(&tab), ["a"]);
    }

    #[test]
    fn keeps_the_newest_requests_and_drops_the_payloads_of_the_ones_it_forgets() {
        let mut tab = TabToolbar::default();
        let total = MAX_HISTORY + 50;
        for index in 0..total {
            tab.receive_request(
                row(&format!("r{index}"), &format!("/api/{index}")),
                Some(data(json!({ "request_id": format!("r{index}") }))),
            );
        }
        let kept: Vec<String> = ids(&tab).iter().map(|s| (*s).to_owned()).collect();
        assert_eq!(kept.len(), MAX_HISTORY);
        assert_eq!(kept[0], "r50");
        assert_eq!(
            kept.last().map(String::as_str),
            Some(format!("r{}", total - 1).as_str())
        );
        let mut sorted = kept;
        sorted.sort();
        assert_eq!(sorted_details(&tab), sorted);
    }

    #[test]
    fn keeps_the_pages_own_request_when_the_cap_would_drop_it() {
        let mut tab = TabToolbar::default();
        tab.receive_page(data(json!({ "request_id": "page", "profiler": {} })));
        for index in 0..MAX_HISTORY + 5 {
            tab.receive_update(data(json!({
                "request_id": format!("x{index}"), "profiler": {},
                "history_row": { "id": format!("x{index}"), "method": "GET", "uri": "/x" }
            })));
        }
        assert_eq!(tab.current_id.as_deref(), Some("page"));
        assert_eq!(tab.history.len(), MAX_HISTORY);
        assert!(tab.history.iter().any(|e| e.row.id == "page"));
        assert!(tab.details.contains_key("page"));
        assert_eq!(tab.details.len(), MAX_HISTORY);
    }

    #[test]
    fn drops_the_payloads_of_cleared_requests() {
        let mut tab = TabToolbar::default();
        tab.receive_request(row("a", "/a"), Some(data(json!({ "request_id": "a" }))));
        tab.receive_request(row("b", "/b"), Some(data(json!({ "request_id": "b" }))));
        tab.select(Some("a"));
        assert_eq!(tab.shown_id(), Some("a"));
        tab.clear_history();
        assert_eq!(ids(&tab), ["b"]);
        assert_eq!(sorted_details(&tab), ["b"]);
        assert_eq!(tab.selected_id, None);
    }

    #[test]
    fn drops_the_payloads_of_requests_an_inertia_history_replaces() {
        let mut tab = TabToolbar::default();
        tab.receive_request(row("a", "/a"), Some(data(json!({ "request_id": "a" }))));
        tab.receive_update(data(json!({ "request_id": "c", "request_history": [ { "id": "c", "method": "GET", "uri": "/c" } ] })));
        assert!(sorted_details(&tab).is_empty());
    }

    #[test]
    fn selecting_the_current_request_is_no_selection_and_forget_clears_a_tab() {
        let mut store = ToolbarStore::default();
        store.tab_mut("t").receive_request(row("a", "/a"), None);
        store.tab_mut("t").select(Some("a"));
        assert_eq!(store.tab("t").and_then(|t| t.selected_id.clone()), None);
        assert!(store.forget("t"));
        assert!(store.tab("t").is_none());
        assert!(!store.forget("t"));
    }
}
