//! GitHub issues: T3's `GitHubIssueTracker.ts` reads and writes and `gitHubIssueJson.ts` shapes,
//! on the panel's pinned credential and generated GraphQL documents.
//!
//! Not built: issue forms written in YAML (`readIssueTemplates`); templates come from GitHub's
//! `issueTemplates` field only.

use super::{Client, Error, HTTP_SLOTS, generated, normalize::array};
use crate::{hosts::github, http::Method};
use serde_json::{Map, Value, json};

const NOT_FOUND: &str = "GitHub could not find the requested issue.";

/// A tracker failure, as `IssueTrackerError` reports it: a reason and a detail.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrackerError {
    pub operation: String,
    pub reason: &'static str,
    pub detail: String,
}

impl TrackerError {
    fn new(operation: &str, reason: &'static str, detail: &str) -> Self {
        Self {
            operation: operation.to_owned(),
            reason,
            detail: detail.to_owned(),
        }
    }
    fn not_found(operation: &str) -> Self {
        Self::new(operation, "not-found", NOT_FOUND)
    }
    /// `fail(operation)`: a request failure, worded by its reason.
    fn from_error(operation: &str, error: &Error) -> Self {
        let reason = match error {
            Error::Missing => "missing-tool",
            Error::Unauthenticated => "unauthenticated",
            Error::RateLimited => "rate-limited",
            Error::NotFound(_) | Error::RepositoryNotFound(..) => "not-found",
            Error::Failed(_) | Error::Forbidden(_) => "failed",
        };
        let detail = match reason {
            "missing-tool" => "GitHub CLI is not installed.",
            "unauthenticated" => "GitHub authentication is unavailable. Sign in and retry.",
            "rate-limited" => "GitHub API rate limit exceeded.",
            "not-found" => NOT_FOUND,
            _ => "The GitHub issue request failed.",
        };
        Self::new(operation, reason, detail)
    }
}

type TrackerResult<T> = Result<T, TrackerError>;

/// `CAPABILITIES`.
pub fn capabilities() -> Value {
    json!({"create": true, "edit": true, "comment": true, "labels": true, "assignees": true,
        "reactions": true, "templates": true, "linkedPullRequests": true, "events": true,
        "search": true})
}

/// `REPOSITORY`: `owner/name`, not `.` or `..`.
fn repository(scope: &str, operation: &str) -> TrackerResult<(String, String)> {
    let invalid = || {
        TrackerError::new(
            operation,
            "failed",
            "A repository was named that GitHub cannot address.",
        )
    };
    let (owner, name) = scope.split_once('/').ok_or_else(invalid)?;
    let owner_ok = owner
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric())
        && owner.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    let name_ok = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
    if !owner_ok || !name_ok || scope.ends_with("/.") || scope.ends_with("/..") {
        return Err(invalid());
    }
    Ok((owner.to_owned(), name.to_owned()))
}

/// `issue`: the repository and a positive issue number from `key`.
fn issue_number(scope: &str, key: &str, operation: &str) -> TrackerResult<(String, String, u32)> {
    let (owner, name) = repository(scope, operation)?;
    let valid = key
        .bytes()
        .next()
        .is_some_and(|b| (b'1'..=b'9').contains(&b))
        && key.bytes().all(|b| b.is_ascii_digit());
    let number = key
        .parse::<u64>()
        .ok()
        .filter(|n| valid && *n <= 2_147_483_647)
        .ok_or_else(|| TrackerError::not_found(operation))?;
    Ok((owner, name, number as u32))
}

// ---- Shapes: `gitHubIssueJson.ts` ----------------------------------------------------------

fn trimmed(value: Option<&Value>) -> Value {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map_or(Value::Null, |s| json!(s))
}

fn nodes(value: Option<&Value>) -> &[Value] {
    array(value.and_then(|v| v.get("nodes")))
}

/// `toActor`.
fn actor(raw: Option<&Value>) -> Value {
    let Some(raw) = raw.filter(|r| r.is_object()) else {
        return Value::Null;
    };
    let login = trimmed(raw.get("login"));
    if login.is_null() {
        return Value::Null;
    }
    json!({"login": login, "name": trimmed(raw.get("name")),
        "avatarUrl": trimmed(raw.get("avatarUrl"))})
}

fn actors(raw: Option<&Value>) -> Vec<Value> {
    nodes(raw)
        .iter()
        .map(|a| actor(Some(a)))
        .filter(|a| !a.is_null())
        .collect()
}

fn labels(raw: Option<&Value>) -> Vec<Value> {
    nodes(raw)
        .iter()
        .filter_map(|label| {
            let name = trimmed(label.get("name"));
            (!name.is_null()).then(|| json!({"name": name, "color": trimmed(label.get("color"))}))
        })
        .collect()
}

/// `ISSUE_STATES`.
pub fn issue_states() -> Value {
    json!([
        {"category": "open", "name": "Open"},
        {"category": "closed", "name": "Completed", "closeReason": "completed"},
        {"category": "closed", "name": "Not planned", "closeReason": "not-planned"},
        {"category": "closed", "name": "Duplicate", "closeReason": "duplicate"},
    ])
}

/// `toIssueState`.
fn issue_state(state: Option<&Value>, reason: Option<&Value>) -> Value {
    let upper = |v: Option<&Value>| {
        v.and_then(Value::as_str)
            .map(|s| s.trim().to_uppercase())
            .unwrap_or_default()
    };
    if upper(state) != "CLOSED" {
        return json!({"category": "open", "name": "Open"});
    }
    match upper(reason).as_str() {
        "COMPLETED" => {
            json!({"category": "closed", "name": "Completed", "closeReason": "completed"})
        }
        "NOT_PLANNED" => {
            json!({"category": "closed", "name": "Not planned", "closeReason": "not-planned"})
        }
        "DUPLICATE" => {
            json!({"category": "closed", "name": "Duplicate", "closeReason": "duplicate"})
        }
        _ => json!({"category": "closed", "name": "Closed"}),
    }
}

/// `toSummary`.
fn summary(raw: &Value) -> Value {
    let number = raw.get("number").cloned().unwrap_or(Value::Null);
    json!({
        "key": number.to_string(),
        "displayKey": format!("#{number}"),
        "title": raw.get("title"),
        "url": raw.get("url"),
        "author": actor(raw.get("author")),
        "state": issue_state(raw.get("state"), raw.get("stateReason")),
        "createdAt": raw.get("createdAt"),
        "updatedAt": raw.get("updatedAt"),
        "closedAt": trimmed(raw.get("closedAt")),
        "assignees": actors(raw.get("assignees")),
        "labels": labels(raw.get("labels")),
        "commentCount": raw.pointer("/comments/totalCount").and_then(Value::as_i64).unwrap_or(0).max(0),
    })
}

/// `toReactions`.
fn reactions(groups: Option<&Value>, viewer: Option<&str>) -> Vec<Value> {
    let viewer = viewer.map(str::to_lowercase);
    array(groups)
        .iter()
        .filter_map(|group| {
            let content = match group["content"]
                .as_str()
                .unwrap_or_default()
                .trim()
                .to_uppercase()
                .as_str()
            {
                "THUMBS_UP" => "thumbs-up",
                "THUMBS_DOWN" => "thumbs-down",
                "LAUGH" => "laugh",
                "HOORAY" => "hooray",
                "CONFUSED" => "confused",
                "HEART" => "heart",
                "ROCKET" => "rocket",
                "EYES" => "eyes",
                _ => return None,
            };
            let reactors = group.get("reactors");
            let logins: Vec<String> = nodes(reactors)
                .iter()
                .filter_map(|n| {
                    let login = trimmed(n.get("login"));
                    login.as_str().map(str::to_owned)
                })
                .collect();
            let total = reactors
                .and_then(|r| r.get("totalCount"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let count = total.max(logins.len() as u64);
            if count == 0 {
                return None;
            }
            let actors: Vec<String> = match &viewer {
                Some(viewer) => logins
                    .into_iter()
                    .filter(|l| l.to_lowercase() != *viewer)
                    .collect(),
                None => logins,
            };
            Some(json!({"content": content, "count": count, "actors": actors,
                "viewerHasReacted": group.get("viewerHasReacted")}))
        })
        .collect()
}

/// `toComments`.
fn comments(raw: Option<&Value>, viewer: Option<&str>) -> Vec<Value> {
    nodes(raw)
        .iter()
        .filter_map(|comment| {
            let id = trimmed(comment.get("id"));
            if comment.is_null() || id.is_null() {
                return None;
            }
            Some(json!({
                "id": id, "author": actor(comment.get("author")),
                "body": comment.get("body").filter(|b| !b.is_null()).cloned().unwrap_or(json!("")),
                "createdAt": comment.get("createdAt"), "url": trimmed(comment.get("url")),
                "reactions": reactions(comment.get("reactionGroups"), viewer),
            }))
        })
        .collect()
}

/// `previousCursorOf`.
fn previous_cursor(connection: Option<&Value>) -> Value {
    let page = connection.and_then(|c| c.get("pageInfo"));
    if page.and_then(|p| p.get("hasPreviousPage")) == Some(&Value::Bool(true)) {
        page.and_then(|p| p.get("startCursor"))
            .cloned()
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    }
}

fn pull_request_state(value: Option<&Value>) -> &'static str {
    match value
        .and_then(Value::as_str)
        .map(|s| s.trim().to_uppercase())
        .as_deref()
    {
        Some("MERGED") => "merged",
        Some("CLOSED") => "closed",
        _ => "open",
    }
}

/// `toLinkedPullRequest`.
fn linked_pull_request(raw: &Value, closes: bool) -> Option<Value> {
    if !raw.is_object() {
        return None;
    }
    Some(json!({
        "repository": raw.pointer("/repository/nameWithOwner"),
        "number": raw.get("number"), "title": raw.get("title"), "url": raw.get("url"),
        "state": pull_request_state(raw.get("state")),
        "isDraft": raw.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        "closesIssue": closes,
    }))
}

/// `toEventFields`.
fn event_fields(raw: &Value) -> Option<(&'static str, Value)> {
    let assignee = || {
        trimmed(
            raw.get("assignee")
                .filter(|a| a.get("login").is_some())
                .and_then(|a| a.get("login")),
        )
    };
    Some(match raw["__typename"].as_str()? {
        "ClosedEvent" => ("closed", Value::Null),
        "ReopenedEvent" => ("reopened", Value::Null),
        "LabeledEvent" => ("labeled", trimmed(raw.pointer("/label/name"))),
        "UnlabeledEvent" => ("unlabeled", trimmed(raw.pointer("/label/name"))),
        "AssignedEvent" => ("assigned", assignee()),
        "UnassignedEvent" => ("unassigned", assignee()),
        "RenamedTitleEvent" => ("renamed", trimmed(raw.get("currentTitle"))),
        "CrossReferencedEvent" => {
            let repository = trimmed(raw.pointer("/source/repository/nameWithOwner"));
            let number = raw
                .pointer("/source/number")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let detail = match repository.as_str() {
                Some(repository) if number > 0 => json!(format!("{repository}#{number}")),
                _ => Value::Null,
            };
            ("referenced", detail)
        }
        _ => return None,
    })
}

/// `toViewerPermissions`.
fn viewer_permissions(permission: Option<&Value>, issue: &Value) -> Value {
    let can_update = issue.get("viewerCanUpdate") != Some(&Value::Bool(false));
    let level = permission
        .and_then(Value::as_str)
        .map(|p| p.trim().to_uppercase())
        .unwrap_or_default();
    let can_triage = matches!(level.as_str(), "ADMIN" | "MAINTAIN" | "WRITE" | "TRIAGE");
    let set_state = if issue["state"] == "CLOSED" {
        issue.get("viewerCanReopen")
    } else {
        issue.get("viewerCanClose")
    }
    .cloned()
    .unwrap_or(Value::Null);
    json!({"setState": set_state, "comment": true, "edit": can_update, "labels": can_triage,
        "assignees": can_triage})
}

/// `toIssueDetail`: `None` for a number that names no issue the viewer can see.
pub fn issue_detail(result: &Value) -> Option<Value> {
    let repository = result.get("repository").filter(|r| !r.is_null())?;
    let issue = repository.get("issue").filter(|i| !i.is_null())?;
    let viewer = trimmed(result.pointer("/viewer/login"));
    let viewer_login = viewer.as_str();
    // Closing references lead; a cross-reference seen twice is filed under the stronger relation.
    let mut links: Vec<(String, Value)> = Vec::new();
    let key_of = |link: &Value| {
        format!(
            "{}#{}",
            link["repository"]
                .as_str()
                .unwrap_or_default()
                .to_lowercase(),
            link["number"]
        )
    };
    for node in nodes(issue.get("closedByPullRequestsReferences")) {
        if let Some(link) = linked_pull_request(node, true) {
            let key = key_of(&link);
            match links.iter_mut().find(|(k, _)| *k == key) {
                Some(entry) => entry.1 = link,
                None => links.push((key, link)),
            }
        }
    }
    let mut events = Vec::new();
    for item in nodes(issue.get("timelineItems")) {
        if item.is_null() {
            continue;
        }
        if item["__typename"] == "CrossReferencedEvent"
            && item.pointer("/source/__typename") == Some(&json!("PullRequest"))
            && let Some(link) = item
                .get("source")
                .and_then(|s| linked_pull_request(s, false))
        {
            let key = key_of(&link);
            if !links.iter().any(|(k, _)| *k == key) {
                links.push((key, link));
            }
        }
        let Some((kind, detail)) = event_fields(item) else {
            continue;
        };
        let id = trimmed(item.get("id"));
        let created = trimmed(item.get("createdAt"));
        if id.is_null() || created.is_null() {
            continue;
        }
        events.push(json!({"id": id, "kind": kind, "detail": detail,
            "actor": actor(item.get("actor")), "createdAt": created}));
    }
    let mut detail = summary(issue);
    let fields: Map<String, Value> = json!({
        "body": issue.get("body").filter(|b| !b.is_null()).cloned().unwrap_or(json!("")),
        "viewer": viewer,
        "viewerPermissions": viewer_permissions(repository.get("viewerPermission"), issue),
        "states": issue_states(),
        "reactions": reactions(issue.get("reactionGroups"), viewer_login),
        "comments": comments(issue.get("comments"), viewer_login),
        "commentsCursor": previous_cursor(issue.get("comments")),
        "events": events,
        "linkedPullRequests": links.into_iter().map(|(_, l)| l).collect::<Vec<_>>(),
    })
    .as_object()
    .cloned()
    .unwrap_or_default();
    if let Some(map) = detail.as_object_mut() {
        map.extend(fields);
    }
    Some(detail)
}

/// `toIssueSearch`.
pub fn issue_search(result: &Value) -> Value {
    let search = result.get("search").unwrap_or(&Value::Null);
    let items: Vec<Value> = nodes(Some(search))
        .iter()
        .filter(|n| n["__typename"] == "Issue")
        .map(summary)
        .collect();
    let next = if search.pointer("/pageInfo/hasNextPage") == Some(&Value::Bool(true)) {
        search
            .pointer("/pageInfo/endCursor")
            .cloned()
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    json!({"items": items, "nextCursor": next})
}

/// `toIssueComments`.
pub fn issue_comments(result: &Value) -> Value {
    let comments_raw = result.pointer("/repository/issue/comments");
    let viewer = result.pointer("/viewer/login").and_then(Value::as_str);
    json!({"comments": comments(comments_raw, viewer), "nextCursor": previous_cursor(comments_raw)})
}

/// `toIssueCandidates`.
pub fn issue_candidates(repository: &Value) -> Value {
    let label_list: Vec<Value> = nodes(repository.get("labels"))
        .iter()
        .filter(|l| !l.is_null())
        .map(|l| json!({"name": l.get("name"), "color": l.get("color"), "description": l.get("description")}))
        .collect();
    let assignees: Vec<Value> = actors(repository.get("assignableUsers"))
        .into_iter()
        .map(|mut a| {
            a["id"] = a["login"].clone();
            a
        })
        .collect();
    let truncated = repository.pointer("/labels/pageInfo/hasNextPage") == Some(&Value::Bool(true))
        || repository.pointer("/assignableUsers/pageInfo/hasNextPage") == Some(&Value::Bool(true));
    json!({"labels": label_list, "assignees": assignees, "truncated": truncated})
}

/// `toIssueTemplates`.
pub fn issue_templates(repository: &Value) -> TrackerResult<Value> {
    let templates: Vec<Value> = array(repository.get("issueTemplates"))
        .iter()
        .filter(|t| !t.is_null() && !t["filename"].as_str().unwrap_or_default().trim().is_empty())
        .map(|t| {
            let names = |path: &str, key: &str| -> Vec<Value> {
                nodes(t.get(path))
                    .iter()
                    .filter_map(|n| n.get(key).filter(|v| v.is_string()).cloned())
                    .collect()
            };
            let text = |key: &str| {
                t.get(key)
                    .filter(|v| !v.is_null())
                    .cloned()
                    .unwrap_or(json!(""))
            };
            json!({"key": t.get("filename"), "name": t.get("name"), "about": text("about"),
                "title": text("title"), "body": text("body"), "labels": names("labels", "name"),
                "assignees": names("assignees", "login")})
        })
        .collect();
    Ok(json!({"templates": templates, "blankIssuesEnabled": blank_issues_enabled(repository)?}))
}

/// `blank_issues_enabled` from `.github/ISSUE_TEMPLATE/config.y(a)ml`, read as one top-level
/// `key: false` line. YAML issue forms themselves are not read (T3 parses them with `yaml`).
fn blank_issues_enabled(repository: &Value) -> TrackerResult<bool> {
    let directory = repository.get("templateDirectory");
    if directory
        .and_then(|d| d.get("__typename"))
        .and_then(Value::as_str)
        != Some("Tree")
    {
        return Ok(true);
    }
    let mut enabled = true;
    for entry in array(directory.and_then(|d| d.get("entries"))) {
        let name = entry["name"]
            .as_str()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !(name.ends_with(".yml") || name.ends_with(".yaml")) {
            continue;
        }
        let blob = &entry["object"];
        let text = blob["text"]
            .as_str()
            .filter(|_| blob["__typename"] == "Blob" && blob["isTruncated"] != Value::Bool(true));
        let Some(text) = text else {
            return Err(TrackerError::new(
                "listTemplates",
                "failed",
                "GitHub returned incomplete issue template contents.",
            ));
        };
        if matches!(name.as_str(), "config.yml" | "config.yaml") {
            enabled = !text.lines().any(|line| {
                let line = line.split(" #").next().unwrap_or_default().trim_end();
                [
                    "blank_issues_enabled:",
                    "\"blank_issues_enabled\":",
                    "'blank_issues_enabled':",
                ]
                .iter()
                .any(|key| {
                    line.strip_prefix(key)
                        .is_some_and(|value| value.trim() == "false")
                })
            });
        }
    }
    Ok(enabled)
}

/// `searchQuery`.
pub fn search_query(input: &Value, viewer: Option<&str>) -> String {
    let quoted = |value: &str| format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""));
    let mut parts = vec![
        "is:issue".to_owned(),
        format!(
            "repo:{}",
            input["scope"].as_str().unwrap_or_default().trim()
        ),
    ];
    let state = input["state"].as_str().unwrap_or("open");
    if state != "all" {
        parts.push(format!("is:{state}"));
    }
    let involvement = input["involvement"].as_str().unwrap_or("all");
    if involvement != "all" {
        let qualifier = match involvement {
            "assigned" => "assignee",
            "authored" => "author",
            _ => "mentions",
        };
        parts.push(format!("{qualifier}:{}", viewer.unwrap_or_default()));
    }
    for label in array(input.get("labels")).iter().filter_map(Value::as_str) {
        parts.push(format!("label:{}", quoted(label)));
    }
    if let Some(assignee) = input["assignee"].as_str() {
        parts.push(format!("assignee:{}", quoted(assignee)));
    }
    parts.push(format!(
        "sort:{}-desc",
        input["sort"].as_str().unwrap_or("updated")
    ));
    for word in input["query"]
        .as_str()
        .unwrap_or_default()
        .split(|c: char| conn_support::text::is_js_space(c))
        .filter(|w| !w.is_empty())
    {
        parts.push(quoted(word));
    }
    parts.join(" ")
}

// ---- Reads and writes ------------------------------------------------------------------------

impl Client {
    async fn issue_graphql(
        &self,
        operation: &'static str,
        document: &super::Operation,
        variables: Value,
    ) -> TrackerResult<Value> {
        self.graphql(document, variables)
            .await
            .map_err(|error| TrackerError::from_error(operation, &error))
    }

    async fn issue_rest(
        &self,
        operation: &'static str,
        method: Method,
        path: &str,
        body: Value,
    ) -> TrackerResult<Value> {
        let _slot = HTTP_SLOTS.acquire().await.map_err(|_| {
            TrackerError::new(operation, "failed", "The GitHub issue request failed.")
        })?;
        let response = github::rest(
            github::RestRequest {
                host: &self.host,
                method,
                path,
                body: Some(body),
            },
            self.token.clone(),
            Some(&self.root),
            github::RestOptions::default(),
        )
        .await
        .map_err(|error| TrackerError::from_error(operation, &self.api_error(error)))?;
        Ok(serde_json::from_slice(&response.body).unwrap_or(Value::Null))
    }

    /// `getViewer`.
    pub async fn issue_viewer(&self) -> TrackerResult<String> {
        let result = self
            .issue_graphql("getViewer", &generated::ISSUE_VIEWER, json!({}))
            .await?;
        Ok(result
            .pointer("/viewer/login")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned())
    }

    /// `listIssues`: `input` carries scope, state, involvement, query, labels, assignee, sort,
    /// limit and cursor; `viewer` is the login a narrowed listing compares against.
    pub async fn list_issues(&self, input: &Value, viewer: Option<&str>) -> TrackerResult<Value> {
        repository(input["scope"].as_str().unwrap_or_default(), "listIssues")?;
        let limit = input["limit"]
            .as_f64()
            .unwrap_or(50.0)
            .trunc()
            .clamp(1.0, 100.0) as u64;
        // An absent cursor is left out, as Effect's client leaves out an undefined variable.
        let mut variables = json!({"q": search_query(input, viewer), "rows": limit});
        if let Some(cursor) = input.get("cursor").filter(|c| !c.is_null()) {
            variables["cursor"] = cursor.clone();
        }
        let result = self
            .issue_graphql("listIssues", &generated::ISSUE_SEARCH, variables)
            .await?;
        Ok(issue_search(&result))
    }

    /// `getIssue`, with labels, assignees and closing references paged to the end.
    pub async fn get_issue(&self, scope: &str, key: &str) -> TrackerResult<Value> {
        let (owner, name, number) = issue_number(scope, key, "getIssue")?;
        let mut result = self
            .issue_graphql(
                "getIssue",
                &generated::ISSUE_DETAIL,
                json!({"owner": owner, "name": name, "number": number}),
            )
            .await?;
        if result
            .pointer("/repository/issue")
            .is_none_or(Value::is_null)
        {
            return Err(TrackerError::not_found("getIssue"));
        }
        let invalid = |detail: &str| TrackerError::new("getIssue", "failed", detail);
        let mut more_labels = Vec::new();
        let mut more_assignees = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let page = |value: Option<&Value>| -> (bool, Option<String>) {
            let info = value.and_then(|v| v.get("pageInfo"));
            let has = info.and_then(|i| i.get("hasNextPage")) == Some(&Value::Bool(true));
            let cursor = info
                .and_then(|i| i.get("endCursor"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            (has, cursor)
        };
        let mut labels_conn = result.pointer("/repository/issue/labels").cloned();
        let mut assignees_conn = result.pointer("/repository/issue/assignees").cloned();
        let mut closing_conn = result
            .pointer("/repository/issue/closedByPullRequestsReferences")
            .cloned();
        let mut all_closing: Vec<Value> = nodes(closing_conn.as_ref()).to_vec();
        loop {
            let (labels_more, labels_cursor) = page(labels_conn.as_ref());
            let (assignees_more, assignees_cursor) = page(assignees_conn.as_ref());
            let (closing_more, closing_cursor) = page(closing_conn.as_ref());
            if !labels_more && !assignees_more && !closing_more {
                break;
            }
            let labels_cursor = labels_cursor.filter(|_| labels_more);
            let assignees_cursor = assignees_cursor.filter(|_| assignees_more);
            let closing_cursor = closing_cursor.filter(|_| closing_more);
            let key = format!(
                "{} {} {}",
                labels_cursor.as_deref().unwrap_or(""),
                assignees_cursor.as_deref().unwrap_or(""),
                closing_cursor.as_deref().unwrap_or("")
            );
            if (labels_more && labels_cursor.is_none())
                || (assignees_more && assignees_cursor.is_none())
                || (closing_more && closing_cursor.is_none())
                || !seen.insert(key)
            {
                return Err(invalid(
                    "GitHub did not return complete issue labels, assignees or linked pull requests.",
                ));
            }
            let next = self
                .issue_graphql(
                    "getIssue",
                    &generated::ISSUE_COLLECTIONS,
                    json!({"owner": owner, "name": name, "number": number,
                        "labelsCursor": labels_cursor, "assigneesCursor": assignees_cursor,
                        "closingPullRequestsCursor": closing_cursor,
                        "withLabels": labels_cursor.is_some(),
                        "withAssignees": assignees_cursor.is_some(),
                        "withClosingPullRequests": closing_cursor.is_some()}),
                )
                .await?;
            let Some(issue) = next.pointer("/repository/issue").filter(|i| !i.is_null()) else {
                return Err(TrackerError::not_found("getIssue"));
            };
            if labels_cursor.is_some() {
                let Some(conn) = issue.get("labels").filter(|l| !l.is_null()) else {
                    return Err(invalid("GitHub did not return complete issue labels."));
                };
                more_labels.extend(labels(Some(conn)));
                labels_conn = Some(conn.clone());
            }
            if assignees_cursor.is_some() {
                let Some(conn) = issue.get("assignees") else {
                    return Err(invalid("GitHub did not return complete issue assignees."));
                };
                more_assignees.extend(actors(Some(conn)));
                assignees_conn = Some(conn.clone());
            }
            if closing_cursor.is_some() {
                let Some(conn) = issue
                    .get("closedByPullRequestsReferences")
                    .filter(|c| !c.is_null())
                else {
                    return Err(invalid(
                        "GitHub did not return complete linked pull requests.",
                    ));
                };
                all_closing.extend(nodes(Some(conn)).iter().cloned());
                closing_conn = Some(conn.clone());
            }
        }
        if let Some(closing) = result
            .pointer_mut("/repository/issue/closedByPullRequestsReferences")
            .filter(|c| !c.is_null())
        {
            closing["nodes"] = json!(all_closing);
        }
        let mut detail =
            issue_detail(&result).ok_or_else(|| TrackerError::not_found("getIssue"))?;
        if let Some(list) = detail["labels"].as_array_mut() {
            list.extend(more_labels);
        }
        if let Some(list) = detail["assignees"].as_array_mut() {
            list.extend(more_assignees);
        }
        Ok(detail)
    }

    /// `getComments`.
    pub async fn issue_comments_page(
        &self,
        scope: &str,
        key: &str,
        cursor: &Value,
    ) -> TrackerResult<Value> {
        let (owner, name, number) = issue_number(scope, key, "getComments")?;
        let result = self
            .issue_graphql(
                "getComments",
                &generated::ISSUE_COMMENTS,
                json!({"owner": owner, "name": name, "number": number, "cursor": cursor}),
            )
            .await?;
        if result
            .pointer("/repository/issue")
            .is_none_or(Value::is_null)
        {
            return Err(TrackerError::not_found("getComments"));
        }
        Ok(issue_comments(&result))
    }

    /// `verifiedIssue`: an Issue (not a pull request) and its node id and state.
    async fn verified_issue(
        &self,
        scope: &str,
        key: &str,
        operation: &'static str,
    ) -> TrackerResult<(String, Value)> {
        let (owner, name, number) = issue_number(scope, key, operation)?;
        let result = self
            .issue_graphql(
                operation,
                &generated::ISSUE_NODE_ID,
                json!({"owner": owner, "name": name, "number": number}),
            )
            .await?;
        let found = result
            .pointer("/repository/issue")
            .filter(|i| !i.is_null())
            .cloned()
            .ok_or_else(|| TrackerError::not_found(operation))?;
        Ok((format!("repos/{owner}/{name}/issues/{number}"), found))
    }

    /// `create`.
    pub async fn create_issue(&self, scope: &str, input: &Value) -> TrackerResult<Value> {
        let (owner, name) = repository(scope, "create")?;
        let body = json!({"title": input["title"], "body": input["body"],
            "labels": input["labels"], "assignees": input["assignees"]});
        let created = self
            .issue_rest(
                "create",
                Method::Post,
                &format!("repos/{owner}/{name}/issues"),
                body,
            )
            .await?;
        match (
            created.get("number").and_then(Value::as_i64),
            created
                .get("html_url")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|u| !u.is_empty()),
        ) {
            (Some(number), Some(url)) => Ok(json!({"key": number.to_string(),
                "displayKey": format!("#{number}"), "url": url})),
            _ => Err(TrackerError::new(
                "create",
                "failed",
                "GitHub returned an unreadable create response.",
            )),
        }
    }

    /// `comment`.
    pub async fn comment_on_issue(
        &self,
        scope: &str,
        key: &str,
        body: &Value,
    ) -> TrackerResult<()> {
        let (path, _) = self.verified_issue(scope, key, "comment").await?;
        self.issue_rest(
            "comment",
            Method::Post,
            &format!("{path}/comments"),
            json!({"body": body}),
        )
        .await?;
        Ok(())
    }

    /// `update`: GitHub drops labels and assignees without triage access and still succeeds.
    pub async fn update_issue(&self, scope: &str, key: &str, input: &Value) -> TrackerResult<()> {
        let (path, _) = self.verified_issue(scope, key, "update").await?;
        let mut body = Map::new();
        for field in ["title", "body", "labels", "assignees"] {
            if let Some(value) = input.get(field) {
                body.insert(field.into(), value.clone());
            }
        }
        let applied = self
            .issue_rest("update", Method::Patch, &path, Value::Object(body))
            .await?;
        let lowered = |values: Vec<String>| -> std::collections::BTreeSet<String> {
            values
                .into_iter()
                .map(|v| v.trim().to_lowercase())
                .collect()
        };
        let same = |wanted: &Value, applied: Option<std::collections::BTreeSet<String>>| {
            let Some(applied) = applied else {
                return true;
            };
            let wanted = lowered(
                array(Some(wanted))
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect(),
            );
            wanted == applied
        };
        let applied_labels = applied.get("labels").and_then(Value::as_array).map(|list| {
            lowered(
                list.iter()
                    .filter_map(|l| l.as_str().or_else(|| l["name"].as_str()))
                    .map(str::to_owned)
                    .collect(),
            )
        });
        let applied_assignees = applied
            .get("assignees")
            .and_then(Value::as_array)
            .map(|list| {
                lowered(
                    list.iter()
                        .filter_map(|a| a["login"].as_str())
                        .map(str::to_owned)
                        .collect(),
                )
            });
        let decoded = applied_labels.is_some() && applied_assignees.is_some();
        if decoded
            && (input
                .get("labels")
                .is_some_and(|l| !same(l, applied_labels))
                || input
                    .get("assignees")
                    .is_some_and(|a| !same(a, applied_assignees)))
        {
            return Err(TrackerError::new(
                "update",
                "failed",
                "GitHub did not apply the labels or assignees. Changing them needs triage access to the repository.",
            ));
        }
        Ok(())
    }

    /// `setState`: `state` is one of `ISSUE_STATES`' names.
    pub async fn set_issue_state(&self, scope: &str, key: &str, state: &str) -> TrackerResult<()> {
        let (path, found) = self.verified_issue(scope, key, "setState").await?;
        let states = issue_states();
        let Some(wanted) = array(Some(&states)).iter().find(|s| s["name"] == state) else {
            return Err(TrackerError::new(
                "setState",
                "failed",
                &format!("A GitHub issue has no \"{state}\" state."),
            ));
        };
        let reason = wanted["closeReason"].as_str().map(|r| r.replace('-', "_"));
        if let Some(reason) = &reason
            && found["state"] == "CLOSED"
            && found["stateReason"]
                .as_str()
                .map(str::to_lowercase)
                .as_deref()
                != Some(reason)
        {
            return Err(TrackerError::new(
                "setState",
                "failed",
                "GitHub cannot change why a closed issue was closed. Reopen it, then close it again.",
            ));
        }
        let mut body = json!({"state": wanted["category"]});
        if let Some(reason) = reason {
            body["state_reason"] = json!(reason);
        }
        self.issue_rest("setState", Method::Patch, &path, body)
            .await?;
        Ok(())
    }

    /// `setReaction`: on the issue, or on one of its comments.
    pub async fn react_to_issue(&self, scope: &str, key: &str, input: &Value) -> TrackerResult<()> {
        let subject = match input.get("subjectId").and_then(Value::as_str) {
            None => self.verified_issue(scope, key, "setReaction").await?.1["id"].clone(),
            Some(comment) => {
                let (owner, name, number) = issue_number(scope, key, "setReaction")?;
                let result = self
                    .issue_graphql(
                        "setReaction",
                        &generated::ISSUE_COMMENT_SCOPE,
                        json!({"owner": owner, "name": name, "number": number,
                            "commentId": comment}),
                    )
                    .await?;
                let expected = result.pointer("/repository/issue/id");
                if expected.is_none_or(Value::is_null)
                    || result.pointer("/node/__typename") != Some(&json!("IssueComment"))
                    || result.pointer("/node/issue/id") != expected
                {
                    return Err(TrackerError::new(
                        "setReaction",
                        "failed",
                        "The comment does not belong to the selected issue.",
                    ));
                }
                json!(comment)
            }
        };
        let content = match input["content"].as_str().unwrap_or_default() {
            "thumbs-up" => "THUMBS_UP",
            "thumbs-down" => "THUMBS_DOWN",
            "laugh" => "LAUGH",
            "hooray" => "HOORAY",
            "confused" => "CONFUSED",
            "heart" => "HEART",
            "rocket" => "ROCKET",
            _ => "EYES",
        };
        let variables = json!({"subjectId": subject, "content": content});
        let operation = if input["reacted"] == true {
            &generated::ADD_REACTION
        } else {
            &generated::REMOVE_REACTION
        };
        self.issue_graphql("setReaction", operation, variables)
            .await?;
        Ok(())
    }

    /// `listTemplates`, from GitHub's `issueTemplates` (no YAML forms).
    pub async fn issue_template_list(&self, scope: &str) -> TrackerResult<Value> {
        let (owner, name) = repository(scope, "listTemplates")?;
        let result = self
            .issue_graphql(
                "listTemplates",
                &generated::ISSUE_TEMPLATES,
                json!({"owner": owner, "name": name}),
            )
            .await?;
        let repo = result
            .get("repository")
            .filter(|r| !r.is_null())
            .ok_or_else(|| TrackerError::not_found("listTemplates"))?;
        issue_templates(repo)
    }

    /// `listCandidates`.
    pub async fn issue_candidate_list(&self, scope: &str) -> TrackerResult<Value> {
        let (owner, name) = repository(scope, "listCandidates")?;
        let result = self
            .issue_graphql(
                "listCandidates",
                &generated::ISSUE_CANDIDATES,
                json!({"owner": owner, "name": name}),
            )
            .await?;
        let repo = result
            .get("repository")
            .filter(|r| !r.is_null())
            .ok_or_else(|| TrackerError::not_found("listCandidates"))?;
        Ok(issue_candidates(repo))
    }
}
