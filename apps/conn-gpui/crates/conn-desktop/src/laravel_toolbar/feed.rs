//! Where a browser tab's toolbar data comes from, and in what order it counts
//! (`apps/desktop/src/preview/LaravelToolbarPreload.ts`, `ResponseHeaderRelay.ts`,
//! `apps/web/src/laravelToolbar/bridge.ts`).
//!
//! Three sources feed a tab:
//! - the page's own data: `window.__LARAVEL_TOOLBAR_DATA__` on DOMContentLoaded and the
//!   `laravel-toolbar:update` events of its fetch/XHR calls;
//! - the response headers `x-toolbar` / `x-toolbar-summary`, read natively, for pages with a CSP
//!   that get no inline data. The document's payload waits for the page; fetch/XHR payloads go
//!   straight through once the document's source is known;
//! - nothing: a page that is not a Laravel page clears the tab (`none`).
//!
//! [`ToolbarFeed`] orders them; [`apply_message`] writes the result to the [`ToolbarStore`].

use serde_json::Value;

use super::model::{ToolbarData, ToolbarHistoryRow};
use super::store::ToolbarStore;
use crate::api_request::toolbar::{
    ToolbarHeaderPayload, decode_toolbar_headers, minimal_toolbar_row,
};

/// Hides the page's own toolbar while the client draws it under the page
/// (`HIDE_PAGE_TOOLBAR_CSS`).
pub const HIDE_PAGE_TOOLBAR_CSS: &str =
    "#laravel-toolbar-shadow-host { display: none !important; }";

/// What the client tells the page's toolbar it is hosted by (`__LARAVEL_TOOLBAR_HOST__`): from
/// laravel-toolbar 0.3.7 on, the page then reports requests but draws no bar of its own.
pub const TOOLBAR_HOST_NAME: &str = "Conn";

/// The in-page request a summary's full payload comes from: a same-origin fetch, so the session
/// cookie applies. The toolbar answers `{ summary, raw }`; `raw` is the payload.
#[must_use]
pub fn details_path(id: &str) -> String {
    format!("/_toolbar/requests/{}", encode_component(id))
}

fn encode_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Two URLs of the same document: only the fragment may differ (`sameDocumentUrl`).
#[must_use]
pub fn same_document_url(a: &str, b: &str) -> bool {
    let strip = |url: &str| url.split('#').next().unwrap_or(url).to_owned();
    strip(a) == strip(b)
}

/// The toolbar payload of one response, with a summary without a row given one made from the
/// request (`toolbarPayloadFromResponse`).
#[must_use]
pub fn payload_from_response(
    full: Option<&str>,
    summary: Option<&str>,
    method: &str,
    url: &str,
) -> Option<ToolbarHeaderPayload> {
    match decode_toolbar_headers(full, summary)? {
        ToolbarHeaderPayload::Summary { id, row: None } => {
            let row = minimal_toolbar_row(&id, Some(method), Some(url));
            Some(ToolbarHeaderPayload::Summary { id, row: Some(row) })
        }
        other => Some(other),
    }
}

/// What a tab's toolbar is told (`{ kind, data }` of the preload).
#[derive(Debug, Clone, PartialEq)]
pub enum ToolbarMessage {
    /// A full page load: start over from the document's payload.
    Page(ToolbarData),
    /// The document's payload was too big for a header: show its row now; the bar loads the
    /// details through [`details_path`].
    PageSummary {
        request_id: String,
        history_row: Option<ToolbarHistoryRow>,
    },
    /// A later request: a full payload, or `{ request_id, history_row }` for a summary.
    Update(ToolbarData),
    /// The page left Laravel or reloaded without the toolbar.
    None,
}

/// Which kind of response a header payload came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponseKind {
    /// The main frame's document (redirects pass through; the last response is the document's).
    Document,
    /// A fetch or XHR.
    Fetch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HeaderUpdates {
    /// The document's source is not known yet: updates wait.
    Pending,
    /// The page sends no inline data: the headers carry the requests.
    Relay,
    /// The page reports its own requests: the headers are ignored.
    Ignore,
}

#[derive(Debug, Clone)]
struct DocumentResponse {
    url: String,
    /// Taken once, for this document only.
    payload: Option<ToolbarHeaderPayload>,
}

/// One browser tab's feed.
#[derive(Debug)]
pub struct ToolbarFeed {
    updates: HeaderUpdates,
    pending: Vec<ToolbarHeaderPayload>,
    document: Option<DocumentResponse>,
}

impl Default for ToolbarFeed {
    fn default() -> Self {
        Self {
            updates: HeaderUpdates::Pending,
            pending: Vec::new(),
            document: None,
        }
    }
}

fn relay(payload: ToolbarHeaderPayload) -> ToolbarMessage {
    match payload {
        ToolbarHeaderPayload::Full { data } => ToolbarMessage::Update(data),
        ToolbarHeaderPayload::Summary { id, row } => {
            let mut data = ToolbarData::new();
            data.insert("request_id".to_owned(), Value::String(id));
            if let Some(row) = row
                && let Ok(value) = serde_json::to_value(row)
            {
                data.insert("history_row".to_owned(), value);
            }
            ToolbarMessage::Update(data)
        }
    }
}

impl ToolbarFeed {
    /// A response read natively (`onHeadersReceived`). Returns what the tab is told now.
    pub fn response(
        &mut self,
        kind: ResponseKind,
        url: &str,
        payload: Option<ToolbarHeaderPayload>,
    ) -> Vec<ToolbarMessage> {
        match kind {
            ResponseKind::Document => {
                self.document = Some(DocumentResponse {
                    url: url.to_owned(),
                    payload,
                });
                Vec::new()
            }
            ResponseKind::Fetch => {
                let Some(payload) = payload else {
                    return Vec::new();
                };
                match self.updates {
                    HeaderUpdates::Relay => vec![relay(payload)],
                    HeaderUpdates::Pending => {
                        self.pending.push(payload);
                        Vec::new()
                    }
                    HeaderUpdates::Ignore => Vec::new(),
                }
            }
        }
    }

    /// A new document starts loading: what waited for the old one is dropped.
    pub fn new_document(&mut self) {
        self.updates = HeaderUpdates::Pending;
        self.pending.clear();
    }

    /// DOMContentLoaded with `__LARAVEL_TOOLBAR_DATA__`: the page reports for itself.
    pub fn page_data(&mut self, data: ToolbarData) -> Vec<ToolbarMessage> {
        self.updates = HeaderUpdates::Ignore;
        self.pending.clear();
        vec![ToolbarMessage::Page(data)]
    }

    /// DOMContentLoaded without inline data: the document's header payload decides, then the
    /// updates that waited follow.
    pub fn page_ready(&mut self, url: &str) -> Vec<ToolbarMessage> {
        let payload = self
            .document
            .as_mut()
            .filter(|document| same_document_url(&document.url, url))
            .and_then(|document| document.payload.take());
        let mut messages = vec![match payload {
            Some(ToolbarHeaderPayload::Full { data }) => ToolbarMessage::Page(data),
            Some(ToolbarHeaderPayload::Summary { id, row }) => ToolbarMessage::PageSummary {
                request_id: id,
                history_row: row,
            },
            None => ToolbarMessage::None,
        }];
        self.updates = HeaderUpdates::Relay;
        messages.extend(self.pending.drain(..).map(relay));
        messages
    }

    /// A `laravel-toolbar:update` event of the page's own toolbar.
    #[must_use]
    pub fn page_update(data: ToolbarData) -> ToolbarMessage {
        ToolbarMessage::Update(data)
    }

    /// The main frame moved to `url` without loading a new document (pushState, Inertia visits).
    pub fn navigated_in_page(&mut self, url: &str) {
        if let Some(document) = &mut self.document {
            url.clone_into(&mut document.url);
        }
    }
}

/// Writes a message to a tab's toolbar (`relayLaravelToolbarMessage`).
pub fn apply_message(store: &mut ToolbarStore, tab_id: &str, message: ToolbarMessage) {
    match message {
        ToolbarMessage::Page(data) => store.tab_mut(tab_id).receive_page(data),
        ToolbarMessage::PageSummary {
            request_id,
            history_row,
        } => {
            let row = history_row.unwrap_or_else(|| minimal_toolbar_row(&request_id, None, None));
            store.forget(tab_id);
            store.tab_mut(tab_id).receive_request(row, None);
        }
        ToolbarMessage::Update(data) => store.tab_mut(tab_id).receive_update(data),
        ToolbarMessage::None => {
            store.forget(tab_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use serde_json::json;

    use super::*;

    fn data(value: Value) -> ToolbarData {
        match value {
            Value::Object(map) => map,
            _ => ToolbarData::new(),
        }
    }

    fn header(value: &Value) -> String {
        base64::engine::general_purpose::STANDARD.encode(value.to_string())
    }

    fn full(id: &str) -> ToolbarHeaderPayload {
        ToolbarHeaderPayload::Full {
            data: data(
                json!({ "request_id": id, "profiler": {}, "request": { "method": "GET", "uri": format!("/{id}") } }),
            ),
        }
    }

    fn summary(id: &str) -> ToolbarHeaderPayload {
        ToolbarHeaderPayload::Summary {
            id: id.to_owned(),
            row: Some(minimal_toolbar_row(
                id,
                Some("GET"),
                Some("https://app.test/x"),
            )),
        }
    }

    #[test]
    fn a_page_with_inline_data_reports_for_itself_and_the_headers_are_ignored() {
        let mut feed = ToolbarFeed::default();
        assert!(
            feed.response(
                ResponseKind::Fetch,
                "https://app.test/a",
                Some(full("early"))
            )
            .is_empty()
        );
        let messages = feed.page_data(data(json!({ "request_id": "page", "profiler": {} })));
        assert!(matches!(messages.as_slice(), [ToolbarMessage::Page(_)]));
        assert!(
            feed.response(
                ResponseKind::Fetch,
                "https://app.test/a",
                Some(full("late"))
            )
            .is_empty()
        );
    }

    #[test]
    fn a_csp_page_takes_its_document_payload_then_relays_the_updates_that_waited() {
        let mut feed = ToolbarFeed::default();
        feed.response(
            ResponseKind::Document,
            "https://app.test/home#top",
            Some(full("doc")),
        );
        assert!(
            feed.response(
                ResponseKind::Fetch,
                "https://app.test/api",
                Some(full("early"))
            )
            .is_empty()
        );
        let messages = feed.page_ready("https://app.test/home");
        assert_eq!(messages.len(), 2);
        assert!(
            matches!(&messages[0], ToolbarMessage::Page(d) if d.get("request_id") == Some(&json!("doc")))
        );
        assert!(
            matches!(&messages[1], ToolbarMessage::Update(d) if d.get("request_id") == Some(&json!("early")))
        );
        // From now on updates go straight through.
        let live = feed.response(
            ResponseKind::Fetch,
            "https://app.test/api",
            Some(full("live")),
        );
        assert!(matches!(live.as_slice(), [ToolbarMessage::Update(_)]));
        // The document's payload is taken once.
        assert!(matches!(
            feed.page_ready("https://app.test/home").first(),
            Some(ToolbarMessage::None)
        ));
    }

    #[test]
    fn a_document_summary_shows_its_row_and_a_summary_update_carries_its_row() {
        let mut feed = ToolbarFeed::default();
        feed.response(
            ResponseKind::Document,
            "https://app.test/",
            Some(summary("big")),
        );
        let messages = feed.page_ready("https://app.test/");
        assert!(
            matches!(&messages[0], ToolbarMessage::PageSummary { request_id, history_row: Some(row) }
            if request_id == "big" && row.uri == "/x")
        );
        let update = feed.response(
            ResponseKind::Fetch,
            "https://app.test/x",
            Some(summary("next")),
        );
        let ToolbarMessage::Update(update) = &update[0] else {
            panic!("an update");
        };
        assert_eq!(update.get("request_id"), Some(&json!("next")));
        assert_eq!(update["history_row"]["id"], json!("next"));
    }

    #[test]
    fn a_page_that_is_not_laravel_clears_the_tab() {
        let mut feed = ToolbarFeed::default();
        feed.response(ResponseKind::Document, "https://app.test/", None);
        assert!(matches!(
            feed.page_ready("https://app.test/").as_slice(),
            [ToolbarMessage::None]
        ));
        // A document of another url never lends its payload.
        let mut other = ToolbarFeed::default();
        other.response(
            ResponseKind::Document,
            "https://app.test/a",
            Some(full("a")),
        );
        assert!(matches!(
            other.page_ready("https://app.test/b").first(),
            Some(ToolbarMessage::None)
        ));
    }

    #[test]
    fn an_in_page_navigation_keeps_the_document_and_a_new_document_drops_what_waited() {
        let mut feed = ToolbarFeed::default();
        feed.response(
            ResponseKind::Document,
            "https://app.test/a",
            Some(full("a")),
        );
        feed.navigated_in_page("https://app.test/b");
        assert!(matches!(
            feed.page_ready("https://app.test/b").first(),
            Some(ToolbarMessage::Page(_))
        ));
        feed.new_document();
        feed.response(ResponseKind::Fetch, "https://app.test/x", Some(full("old")));
        feed.new_document();
        let messages = feed.page_ready("https://app.test/b");
        assert_eq!(
            messages.len(),
            1,
            "the update that waited for the old document is gone"
        );
    }

    #[test]
    fn response_headers_decode_with_a_minimal_row_for_a_summary_without_one() {
        let big = header(&json!({ "request_id": "r9" }));
        let payload = payload_from_response(None, Some(&big), "post", "https://app.test/api?x=1");
        let Some(ToolbarHeaderPayload::Summary { id, row: Some(row) }) = payload else {
            panic!("a summary with a row");
        };
        assert_eq!(
            (id.as_str(), row.method.as_str(), row.uri.as_str()),
            ("r9", "POST", "/api?x=1")
        );
        assert!(payload_from_response(None, None, "GET", "https://app.test/").is_none());
    }

    #[test]
    fn messages_reach_the_tabs_store_and_none_clears_only_that_tab() {
        let mut store = ToolbarStore::default();
        apply_message(
            &mut store,
            "a",
            ToolbarMessage::Page(data(json!({ "request_id": "r1", "profiler": {} }))),
        );
        apply_message(
            &mut store,
            "b",
            ToolbarMessage::PageSummary {
                request_id: "r2".to_owned(),
                history_row: None,
            },
        );
        assert_eq!(
            store.tab("a").and_then(|t| t.current_id.clone()).as_deref(),
            Some("r1")
        );
        assert_eq!(
            store.tab("b").and_then(|t| t.current_id.clone()).as_deref(),
            Some("r2")
        );
        assert!(
            store.tab("b").is_some_and(|t| t.details.is_empty()),
            "a summary has no details yet"
        );
        apply_message(&mut store, "a", ToolbarMessage::None);
        assert!(store.tab("a").is_none());
        assert!(store.tab("b").is_some(), "another tab's data stays");
    }

    #[test]
    fn the_details_request_path_encodes_the_id() {
        assert_eq!(details_path("9f3a"), "/_toolbar/requests/9f3a");
        assert_eq!(details_path("a/b c"), "/_toolbar/requests/a%2Fb%20c");
        assert!(same_document_url("https://a/b#x", "https://a/b#y"));
        assert!(!same_document_url("https://a/b", "https://a/c"));
    }
}
