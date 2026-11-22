//! The API panel's saved requests, per project (persisted), and the last response per request
//! (this session only: bodies can be large).
//!
//! Port of Conn's `apps/web/src/api/apiRequestStore.ts`, plus the pure parts of
//! `ApiPanel.tsx` (selection, duplicate, building the request to send) and
//! `ApiRequestEditor.tsx` (header rows, bodyless methods).

use std::collections::hash_map::RandomState;
use std::collections::{BTreeMap, HashMap};
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use super::{ApiHeader, ApiRequest, ApiResponse};

/// The methods the method menu offers.
pub const API_METHODS: [&str; 7] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/// The URL field's placeholder.
pub const URL_PLACEHOLDER: &str = "https://app.test/api/users";
/// The body field's placeholder.
pub const BODY_PLACEHOLDER: &str = "{\n  \"name\": \"value\"\n}";
/// Conn's `localStorage` key for the persisted store.
pub const STORAGE_KEY: &str = "t3code:api-requests:v1";
/// The persisted format's version.
pub const STORAGE_VERSION: u32 = 1;

/// A name/value row that can be switched off.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApiHeaderRow {
    pub id: String,
    pub name: String,
    pub value: String,
    pub enabled: bool,
}

impl ApiHeaderRow {
    /// An enabled row with a fresh id.
    pub fn new(name: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            id: new_row_id(),
            name: name.into(),
            value: value.into(),
            enabled: true,
        }
    }

    /// The empty row "Add header" appends.
    pub fn empty() -> Self {
        Self::new("", "")
    }

    /// Counts toward the Headers tab and is sent.
    pub fn is_active(&self) -> bool {
        self.enabled && !self.name.trim().is_empty()
    }
}

/// One saved request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApiRequestDraft {
    pub id: String,
    pub method: String,
    pub url: String,
    pub headers: Vec<ApiHeaderRow>,
    pub body: String,
}

impl ApiRequestDraft {
    /// New requests ask for JSON and opt in to the toolbar header, so Laravel data comes back.
    /// The URL is the project's app URL with one trailing slash, or empty.
    pub fn new(base_url: Option<&str>) -> Self {
        let url = match base_url {
            Some(base) if !base.is_empty() => format!("{}/", base.trim_end_matches('/')),
            _ => String::new(),
        };
        Self {
            id: new_row_id(),
            method: "GET".to_owned(),
            url,
            headers: vec![
                ApiHeaderRow::new("Accept", "application/json"),
                ApiHeaderRow::new("X-Toolbar", "1"),
            ],
            body: String::new(),
        }
    }

    /// `GET /api/users`: the method and the URL's path, for menus and tab titles.
    pub fn label(&self) -> String {
        api_request_label(&self.method, &self.url)
    }

    /// A copy with fresh ids, for "Duplicate".
    pub fn duplicate(&self) -> Self {
        Self {
            id: new_row_id(),
            headers: self
                .headers
                .iter()
                .map(|row| ApiHeaderRow {
                    id: new_row_id(),
                    ..row.clone()
                })
                .collect(),
            ..self.clone()
        }
    }

    /// The count on the Headers tab.
    pub fn enabled_header_count(&self) -> usize {
        self.headers.iter().filter(|row| row.is_active()).count()
    }

    /// GET and HEAD send no body; the Body tab says so.
    pub fn is_bodyless(&self) -> bool {
        self.method == "GET" || self.method == "HEAD"
    }

    /// The Body tab's text for a bodyless method.
    pub fn bodyless_notice(&self) -> String {
        format!("{} requests send no body.", self.method)
    }

    /// The Send button needs a URL.
    pub fn can_send(&self) -> bool {
        !self.url.trim().is_empty()
    }

    /// What the panel sends: trimmed URL, active headers only, no body when empty.
    pub fn to_request(&self) -> ApiRequest {
        ApiRequest {
            method: self.method.clone(),
            url: self.url.trim().to_owned(),
            headers: self
                .headers
                .iter()
                .filter(|row| row.is_active())
                .map(|row| ApiHeader::new(row.name.trim(), row.value.clone()))
                .collect(),
            body: (!self.body.is_empty()).then(|| self.body.clone()),
            timeout_ms: None,
        }
    }
}

/// `GET /api/users?page=2`: the method and the URL's path and query; the URL as typed when it
/// does not parse yet, and `New request` when it is empty.
pub fn api_request_label(method: &str, url: &str) -> String {
    let mut path = url.trim().to_owned();
    if let Ok(parsed) = url::Url::parse(&path) {
        path = match parsed.query() {
            Some(query) if !query.is_empty() => format!("{}?{query}", parsed.path()),
            _ => parsed.path().to_owned(),
        };
    }
    if path.is_empty() {
        path = "New request".to_owned();
    }
    format!("{method} {path}")
}

/// An 8-character base-36 id, like Conn's `newRowId`.
pub fn new_row_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    let mut value = hasher.finish();
    let mut id = String::with_capacity(8);
    for _ in 0..8 {
        let digit = u32::try_from(value % 36).unwrap_or_default();
        id.push(char::from_digit(digit, 36).unwrap_or('0'));
        value /= 36;
    }
    id
}

/// Changes to a request; `None` keeps the field. The id never changes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ApiRequestPatch {
    pub method: Option<String>,
    pub url: Option<String>,
    pub headers: Option<Vec<ApiHeaderRow>>,
    pub body: Option<String>,
}

/// One project's saved requests.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiProjectRequests {
    pub requests: Vec<ApiRequestDraft>,
    pub selected_id: Option<String>,
}

impl ApiProjectRequests {
    /// The selected request, else the first one.
    pub fn selected(&self) -> Option<&ApiRequestDraft> {
        self.selected_id
            .as_deref()
            .and_then(|id| self.requests.iter().find(|request| request.id == id))
            .or_else(|| self.requests.first())
    }
}

/// The last response for a request, and whether a send is running.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ApiResult {
    pub response: Option<ApiResponse>,
    pub sending: bool,
}

/// All projects' requests plus this session's results.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ApiRequestStore {
    /// Keyed by Conn's project key (such as `env:/repo`).
    pub by_project_key: BTreeMap<String, ApiProjectRequests>,
    /// Keyed by request id; never persisted.
    pub results: HashMap<String, ApiResult>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedState {
    #[serde(default)]
    by_project_key: BTreeMap<String, ApiProjectRequests>,
}

/// Zustand `persist`'s envelope, so Conn's stored value reads as is.
#[derive(Serialize, Deserialize)]
struct Persisted {
    state: PersistedState,
    #[serde(default)]
    version: u32,
}

impl ApiRequestStore {
    pub fn project(&self, project_key: &str) -> Option<&ApiProjectRequests> {
        self.by_project_key.get(project_key)
    }

    /// The request the panel shows: the selected one, else the first.
    pub fn selected(&self, project_key: &str) -> Option<&ApiRequestDraft> {
        self.project(project_key)?.selected()
    }

    pub fn result(&self, request_id: &str) -> Option<&ApiResult> {
        self.results.get(request_id)
    }

    /// Seeds a project that has no requests with a first one, as the panel does on open.
    pub fn ensure_request(&mut self, project_key: &str, base_url: Option<&str>) {
        let empty = self
            .project(project_key)
            .is_none_or(|project| project.requests.is_empty());
        if empty {
            self.add(project_key, ApiRequestDraft::new(base_url));
        }
    }

    /// Appends a request and selects it.
    pub fn add(&mut self, project_key: &str, request: ApiRequestDraft) {
        let project = self.project_mut(project_key);
        project.selected_id = Some(request.id.clone());
        project.requests.push(request);
    }

    pub fn change(&mut self, project_key: &str, id: &str, patch: ApiRequestPatch) {
        let project = self.project_mut(project_key);
        if let Some(request) = project.requests.iter_mut().find(|request| request.id == id) {
            if let Some(method) = patch.method {
                request.method = method;
            }
            if let Some(url) = patch.url {
                request.url = url;
            }
            if let Some(headers) = patch.headers {
                request.headers = headers;
            }
            if let Some(body) = patch.body {
                request.body = body;
            }
        }
    }

    pub fn select(&mut self, project_key: &str, id: &str) {
        self.project_mut(project_key).selected_id = Some(id.to_owned());
    }

    /// Removes a request and its result. When it was selected, its neighbour (the next one,
    /// else the previous) becomes selected.
    pub fn remove(&mut self, project_key: &str, id: &str) {
        self.results.remove(id);
        let project = self.project_mut(project_key);
        let index = project.requests.iter().position(|request| request.id == id);
        project.requests.retain(|request| request.id != id);
        if project.selected_id.as_deref() == Some(id) {
            let neighbour = index.and_then(|index| {
                let last = project.requests.len().checked_sub(1)?;
                project.requests.get(index.min(last))
            });
            project.selected_id = neighbour.map(|request| request.id.clone());
        }
    }

    pub fn set_result(&mut self, id: &str, result: ApiResult) {
        self.results.insert(id.to_owned(), result);
    }

    /// Marks the selected request as sending (keeping its last response) and returns its id
    /// and the request to send, or `None` when there is nothing to send or a send is running.
    pub fn begin_send(&mut self, project_key: &str) -> Option<(String, ApiRequest)> {
        let draft = self.selected(project_key)?;
        let (id, request) = (draft.id.clone(), draft.to_request());
        let previous = self.results.get(&id);
        if previous.is_some_and(|result| result.sending) {
            return None;
        }
        let response = previous.and_then(|result| result.response.clone());
        self.set_result(
            &id,
            ApiResult {
                response,
                sending: true,
            },
        );
        Some((id, request))
    }

    /// Stores a finished send's response.
    pub fn finish_send(&mut self, id: &str, response: ApiResponse) {
        self.set_result(
            id,
            ApiResult {
                response: Some(response),
                sending: false,
            },
        );
    }

    /// The persisted JSON (requests only), in Conn's `persist` envelope.
    pub fn to_persisted_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(&Persisted {
            state: PersistedState {
                by_project_key: self.by_project_key.clone(),
            },
            version: STORAGE_VERSION,
        })
    }

    /// Reads [`Self::to_persisted_json`] output (or Conn's stored value). Another version
    /// starts empty, as Conn has no migration for it.
    pub fn from_persisted_json(json: &str) -> Result<Self, serde_json::Error> {
        let persisted: Persisted = serde_json::from_str(json)?;
        if persisted.version != STORAGE_VERSION {
            return Ok(Self::default());
        }
        Ok(Self {
            by_project_key: persisted.state.by_project_key,
            results: HashMap::new(),
        })
    }

    fn project_mut(&mut self, project_key: &str) -> &mut ApiProjectRequests {
        self.by_project_key
            .entry(project_key.to_owned())
            .or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROJECT: &str = "env:/repo";

    #[test]
    fn starts_new_requests_at_the_app_url_asking_for_json_and_the_toolbar_header() {
        let request = ApiRequestDraft::new(Some("https://app.test"));
        assert_eq!(request.url, "https://app.test/", "app URL with a slash");
        assert_eq!(
            ApiRequestDraft::new(Some("https://app.test//")).url,
            "https://app.test/",
            "one trailing slash"
        );
        assert_eq!(ApiRequestDraft::new(None).url, "", "no app URL");
        assert_eq!(request.method, "GET", "GET");
        let headers: Vec<String> = request
            .headers
            .iter()
            .map(|row| format!("{}: {}", row.name, row.value))
            .collect();
        assert_eq!(
            headers,
            ["Accept: application/json", "X-Toolbar: 1"],
            "default headers"
        );
        assert!(request.headers.iter().all(|row| row.enabled), "enabled");
    }

    #[test]
    fn labels_a_request_by_method_and_path() {
        assert_eq!(
            api_request_label("POST", "https://app.test/api/users?page=2"),
            "POST /api/users?page=2",
            "path and query"
        );
        assert_eq!(api_request_label("GET", ""), "GET New request", "empty");
        assert_eq!(api_request_label("GET", " /api "), "GET /api", "typed path");
        assert_eq!(
            api_request_label("GET", "https://app.test/?"),
            "GET /",
            "empty query"
        );
    }

    #[test]
    fn selects_the_neighbour_when_the_selected_request_is_deleted() {
        let mut store = ApiRequestStore::default();
        let first = ApiRequestDraft::new(None);
        let second = ApiRequestDraft::new(None);
        store.add(PROJECT, first.clone());
        store.add(PROJECT, second.clone());
        store.set_result(&second.id, ApiResult::default());
        store.remove(PROJECT, &second.id);
        let project = store.project(PROJECT).expect("project exists");
        let ids: Vec<&str> = project.requests.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, [first.id.as_str()], "second removed");
        assert_eq!(
            project.selected_id.as_deref(),
            Some(first.id.as_str()),
            "neighbour"
        );
        assert!(store.result(&second.id).is_none(), "result removed");
    }

    #[test]
    fn removing_picks_the_next_request_and_keeps_other_selections() {
        let mut store = ApiRequestStore::default();
        let [a, b, c] = [(); 3].map(|()| ApiRequestDraft::new(None));
        for request in [&a, &b, &c] {
            store.add(PROJECT, request.clone());
        }
        store.select(PROJECT, &b.id);
        store.remove(PROJECT, &b.id);
        assert_eq!(
            store.selected(PROJECT).map(|r| &r.id),
            Some(&c.id),
            "next one"
        );
        store.remove(PROJECT, &a.id);
        assert_eq!(store.selected(PROJECT).map(|r| &r.id), Some(&c.id), "kept");
        store.remove(PROJECT, &c.id);
        assert_eq!(
            store.project(PROJECT).and_then(|p| p.selected_id.clone()),
            None,
            "none"
        );
    }

    #[test]
    fn changes_keep_the_id_and_unset_fields() {
        let mut store = ApiRequestStore::default();
        store.ensure_request(PROJECT, Some("https://app.test"));
        store.ensure_request(PROJECT, Some("https://other.test"));
        let id = store
            .selected(PROJECT)
            .map(|r| r.id.clone())
            .expect("seeded");
        store.change(
            PROJECT,
            &id,
            ApiRequestPatch {
                method: Some("POST".to_owned()),
                body: Some("{}".to_owned()),
                ..ApiRequestPatch::default()
            },
        );
        let request = store.selected(PROJECT).expect("selected");
        assert_eq!(
            store.project(PROJECT).map(|p| p.requests.len()),
            Some(1),
            "seeded once"
        );
        assert_eq!(
            (request.id.as_str(), request.method.as_str()),
            (id.as_str(), "POST"),
            "patched"
        );
        assert_eq!(request.url, "https://app.test/", "url kept");
    }

    #[test]
    fn falls_back_to_the_first_request_when_the_selection_is_gone() {
        let first = ApiRequestDraft::new(None);
        let project = ApiProjectRequests {
            requests: vec![first.clone()],
            selected_id: Some("missing".to_owned()),
        };
        assert_eq!(project.selected().map(|r| &r.id), Some(&first.id), "first");
    }

    #[test]
    fn builds_the_request_to_send_from_active_rows() {
        let mut draft = ApiRequestDraft::new(Some("https://app.test"));
        draft.url = "  https://app.test/api  ".to_owned();
        draft.headers.push(ApiHeaderRow {
            enabled: false,
            ..ApiHeaderRow::new("X-Off", "1")
        });
        draft.headers.push(ApiHeaderRow::new("  ", "blank"));
        draft.headers.push(ApiHeaderRow::new(" X-Pad ", " v "));
        let request = draft.to_request();
        assert_eq!(request.url, "https://app.test/api", "trimmed URL");
        let names: Vec<(&str, &str)> = request
            .headers
            .iter()
            .map(|h| (h.name.as_str(), h.value.as_str()))
            .collect();
        assert_eq!(
            names,
            [
                ("Accept", "application/json"),
                ("X-Toolbar", "1"),
                ("X-Pad", " v ")
            ],
            "active rows, names trimmed"
        );
        assert_eq!(request.body, None, "empty body is null");
        assert_eq!(draft.enabled_header_count(), 3, "tab count");
        assert!(draft.is_bodyless(), "GET");
        assert_eq!(
            draft.bodyless_notice(),
            "GET requests send no body.",
            "notice"
        );
    }

    #[test]
    fn duplicates_with_fresh_ids() {
        let draft = ApiRequestDraft::new(Some("https://app.test"));
        let copy = draft.duplicate();
        assert_ne!(copy.id, draft.id, "new id");
        assert_ne!(copy.headers[0].id, draft.headers[0].id, "new row id");
        assert_eq!(
            (copy.url, copy.headers[0].name.clone()),
            (draft.url, draft.headers[0].name.clone()),
            "same content"
        );
    }

    #[test]
    fn begin_send_keeps_the_last_response_and_refuses_a_second_send() {
        let mut store = ApiRequestStore::default();
        store.ensure_request(PROJECT, Some("https://app.test"));
        let (id, request) = store.begin_send(PROJECT).expect("sends");
        assert_eq!(request.url, "https://app.test/", "request");
        assert!(store.begin_send(PROJECT).is_none(), "already sending");
        let response = ApiResponse::failure("https://app.test/", "x", 0.0);
        store.finish_send(&id, response.clone());
        assert!(store.begin_send(PROJECT).is_some(), "sends again");
        let result = store.result(&id).expect("result");
        assert!(result.sending, "sending");
        assert_eq!(
            result.response.as_ref(),
            Some(&response),
            "last response kept"
        );
    }

    #[test]
    fn persists_requests_but_not_results_in_conns_format() {
        let mut store = ApiRequestStore::default();
        store.ensure_request(PROJECT, Some("https://app.test"));
        let id = store
            .selected(PROJECT)
            .map(|r| r.id.clone())
            .expect("seeded");
        store.set_result(&id, ApiResult::default());
        let json = store.to_persisted_json().expect("serializes");
        let value: serde_json::Value = serde_json::from_str(&json).expect("json");
        assert_eq!(value["version"], 1, "version");
        assert_eq!(
            value["state"]["byProjectKey"][PROJECT]["selectedId"],
            id.as_str(),
            "camelCase"
        );
        let restored = ApiRequestStore::from_persisted_json(&json).expect("reads");
        assert_eq!(restored.by_project_key, store.by_project_key, "round trip");
        assert!(restored.results.is_empty(), "results not persisted");
        let other = ApiRequestStore::from_persisted_json(
            r#"{"state":{"byProjectKey":{"a":{"requests":[],"selectedId":null}}},"version":2}"#,
        )
        .expect("reads");
        assert!(
            other.by_project_key.is_empty(),
            "unknown version starts empty"
        );
    }

    #[test]
    fn row_ids_are_eight_base36_characters_and_differ() {
        let id = new_row_id();
        assert_eq!(id.len(), 8, "length");
        assert!(
            id.chars()
                .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase()),
            "base 36"
        );
        assert_ne!(new_row_id(), new_row_id(), "unique");
    }
}
