//! `issues.*`: T3's `IssueService` for GitHub, on the panel's projects and pinned credentials.
//! A project's issues live in its GitHub repository (`resolveGitHostBinding`); another
//! repository on the same host is read through it and marked read-only.
//!
//! Not built: standalone trackers (Linear) and their `issueTrackers.*` connections.

use super::{Panel, Project};
use crate::table::Failure;
use conn_source_control::pull_requests::{
    Client,
    issues::{self, TrackerError},
    normalize::{array, text},
};
use serde_json::{Map, Value, json};

const DEFAULT_LIST_LIMIT: u64 = 50;

fn unavailable(reason: &str) -> Failure {
    Failure::Fail(json!({"_tag": "IssueUnavailableError", "reason": reason}))
}

fn operation(operation: &str, detail: &str, reason: Option<&str>) -> Failure {
    let mut error =
        json!({"_tag": "IssueOperationError", "operation": operation, "detail": detail});
    if let Some(reason) = reason {
        error["reason"] = json!(reason);
    }
    Failure::Fail(error)
}

/// `trackerDetail`.
fn tracker_detail(error: &TrackerError) -> String {
    let detail = error.detail.trim();
    if detail.is_empty() {
        "The issue tracker request failed.".to_owned()
    } else {
        detail.to_owned()
    }
}

fn unusable(error: &TrackerError) -> bool {
    matches!(error.reason, "missing-tool" | "unauthenticated")
}

/// `toIssueError`.
fn issue_error(operation_name: &str, error: &TrackerError) -> Failure {
    if unusable(error) {
        let reason = if error.reason == "missing-tool" {
            "tool-missing"
        } else {
            "unauthenticated"
        };
        return Failure::Fail(
            json!({"_tag": "IssueUnavailableError", "reason": reason, "tracker": "github"}),
        );
    }
    let reason = matches!(error.reason, "not-found" | "rate-limited").then_some(error.reason);
    operation(operation_name, &tracker_detail(error), reason)
}

/// One project's GitHub issues, and whether a reference may be written there.
struct Served {
    project: Project,
    scope: String,
    writable: bool,
}

/// `listCursorKey`.
fn cursor_key(host: &str, scope: &str) -> String {
    format!("{host} {}", scope.to_lowercase())
}

/// `threadIssueKeyOf`.
fn issue_key(link: &Value) -> (String, String, String, String) {
    let text_of = |key: &str| link[key].as_str().unwrap_or_default().trim().to_owned();
    (
        text_of("tracker"),
        text_of("host").to_lowercase(),
        text_of("scope").to_lowercase(),
        text_of("key"),
    )
}

impl Panel {
    async fn issue_client(
        &self,
        project: &Project,
        operation_name: &str,
    ) -> Result<Client, Failure> {
        self.client(project, operation_name).await.map_err(|failure| match failure {
            Failure::Fail(error) if error["_tag"] == "PullRequestUnavailableError" => {
                let reason = if error["reason"] == "cli-missing" {
                    "tool-missing"
                } else {
                    "unauthenticated"
                };
                Failure::Fail(
                    json!({"_tag": "IssueUnavailableError", "reason": reason, "tracker": "github"}),
                )
            }
            other => other,
        })
    }

    /// `requireProject`: the project's own tracker; a scope other than its own is read-only.
    async fn issue_project(&self, input: &Value) -> Result<Served, Failure> {
        let projects = self
            .projects(&json!({"projectId": input.get("projectId")}))
            .await
            .map_err(|_| operation("listProjects", "The project list could not be read.", None))?;
        let Some(project) = projects.into_iter().next() else {
            return Err(unavailable("tracker-unsupported"));
        };
        if text(input, "tracker") != "github" {
            return Err(unavailable("tracker-unsupported"));
        }
        let host = input
            .get("host")
            .and_then(Value::as_str)
            .map_or_else(|| project.host.clone(), |h| h.trim().to_lowercase());
        if host != project.host {
            return Err(unavailable("tracker-unsupported"));
        }
        let scope = text(input, "scope").trim().to_owned();
        let writable = scope.eq_ignore_ascii_case(&project.repository);
        Ok(Served {
            project,
            scope,
            writable,
        })
    }

    async fn issue_writable(&self, input: &Value, operation_name: &str) -> Result<Served, Failure> {
        let served = self.issue_project(input).await?;
        if !served.writable {
            return Err(operation(
                operation_name,
                "This issue belongs to a repository outside the selected project and cannot be changed from here.",
                Some("read-only"),
            ));
        }
        Ok(served)
    }

    /// `toDetail`.
    fn issue_detail_of(served: &Served, issue: Value) -> Value {
        let mut detail = issue;
        if let Some(map) = detail.as_object_mut() {
            map.insert("tracker".into(), json!("github"));
            map.insert("host".into(), json!(served.project.host));
            map.insert("scope".into(), json!(served.scope));
            map.insert("projectId".into(), json!(served.project.id));
            map.insert("projectTitle".into(), json!(served.project.title));
            map.insert("writable".into(), json!(served.writable));
            map.insert("capabilities".into(), issues::capabilities());
        }
        detail
    }

    pub(super) async fn issue_call(&self, method: &str, input: &Value) -> Result<Value, Failure> {
        match method {
            "list" => self.issue_list(input).await,
            "linkedThreads" => self.issue_linked_threads(input).await,
            "detail" => {
                let served = self.issue_project(input).await?;
                let client = self.issue_client(&served.project, "detail").await?;
                let issue = client
                    .get_issue(&served.scope, text(input, "key"))
                    .await
                    .map_err(|e| issue_error("detail", &e))?;
                Ok(Self::issue_detail_of(&served, issue))
            }
            "comments" => {
                let served = self.issue_project(input).await?;
                let client = self.issue_client(&served.project, "comments").await?;
                client
                    .issue_comments_page(
                        &served.scope,
                        text(input, "key"),
                        input.get("cursor").unwrap_or(&Value::Null),
                    )
                    .await
                    .map_err(|e| issue_error("comments", &e))
            }
            "templates" => {
                let served = self.issue_project(input).await?;
                let client = self.issue_client(&served.project, "templates").await?;
                client
                    .issue_template_list(&served.scope)
                    .await
                    .map_err(|e| issue_error("templates", &e))
            }
            "candidates" => {
                let served = self.issue_project(input).await?;
                let client = self.issue_client(&served.project, "candidates").await?;
                client
                    .issue_candidate_list(&served.scope)
                    .await
                    .map_err(|e| issue_error("candidates", &e))
            }
            "create" => {
                let served = self.issue_writable(input, "create").await?;
                let client = self.issue_client(&served.project, "create").await?;
                client
                    .create_issue(&served.scope, input)
                    .await
                    .map_err(|e| issue_error("create", &e))
            }
            "comment" => {
                let served = self.issue_writable(input, "comment").await?;
                if text(input, "body").trim().is_empty() {
                    return Err(operation("comment", "A comment needs some text.", None));
                }
                let client = self.issue_client(&served.project, "comment").await?;
                client
                    .comment_on_issue(&served.scope, text(input, "key"), &input["body"])
                    .await
                    .map_err(|e| issue_error("comment", &e))?;
                Ok(Value::Null)
            }
            "update" => {
                let served = self.issue_writable(input, "update").await?;
                if ["title", "body", "labels", "assignees"]
                    .iter()
                    .all(|k| input.get(*k).is_none())
                {
                    return Err(operation("update", "Nothing to change.", None));
                }
                let client = self.issue_client(&served.project, "update").await?;
                client
                    .update_issue(&served.scope, text(input, "key"), input)
                    .await
                    .map_err(|e| issue_error("update", &e))?;
                Ok(Value::Null)
            }
            "setState" => {
                let served = self.issue_writable(input, "setState").await?;
                let client = self.issue_client(&served.project, "setState").await?;
                client
                    .set_issue_state(&served.scope, text(input, "key"), text(input, "state"))
                    .await
                    .map_err(|e| issue_error("setState", &e))?;
                Ok(Value::Null)
            }
            "react" => {
                let served = self.issue_writable(input, "react").await?;
                let client = self.issue_client(&served.project, "react").await?;
                client
                    .react_to_issue(&served.scope, text(input, "key"), input)
                    .await
                    .map_err(|e| issue_error("react", &e))?;
                Ok(Value::Null)
            }
            "projectScope" => {
                let projects = self
                    .projects(&json!({"projectId": input.get("projectId")}))
                    .await
                    .map_err(|_| {
                        operation("listProjects", "The project list could not be read.", None)
                    })?;
                let project = projects
                    .into_iter()
                    .next()
                    .ok_or_else(|| unavailable("tracker-unsupported"))?;
                Ok(
                    json!({"projectId": input.get("projectId"), "tracker": "github",
                    "host": project.host, "scope": project.repository}),
                )
            }
            "resolveUrl" => self.issue_resolve_url(input).await,
            _ => Err(Failure::die(format!("Unknown issue operation {method}"))),
        }
    }

    /// `list`: every GitHub repository the projects check out, each scope read once.
    async fn issue_list(&self, input: &Value) -> Result<Value, Failure> {
        let supported = self
            // An absent projectId lists every project, as in T3.
            .projects(&match input.get("projectId").filter(|id| !id.is_null()) {
                Some(id) => json!({ "projectId": id }),
                None => json!({}),
            })
            .await
            .map_err(|_| operation("listProjects", "The project list could not be read.", None))?;
        let host = input
            .get("host")
            .and_then(Value::as_str)
            .map(|h| h.trim().to_lowercase());
        let limit = input
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_LIST_LIMIT);
        let mut scopes: Vec<(String, &Project)> = Vec::new();
        for project in &supported {
            if host.as_ref().is_some_and(|h| *h != project.host) {
                continue;
            }
            let key = cursor_key(&project.host, &project.repository);
            if !scopes.iter().any(|(k, _)| *k == key) {
                scopes.push((key, project));
            }
        }
        let involvement = input["involvement"].as_str().unwrap_or("all");
        let continuing = input.get("cursors").and_then(Value::as_object);
        let mut viewers = Map::new();
        let mut trackers: Vec<Value> = Vec::new();
        for project in &supported {
            match trackers
                .iter_mut()
                .find(|t| t["host"] == project.host.as_str())
            {
                Some(tracker) => {
                    tracker["projectCount"] =
                        json!(tracker["projectCount"].as_u64().unwrap_or(0) + 1);
                }
                None => trackers.push(json!({"tracker": "github", "host": project.host,
                    "projectCount": 1, "capabilities": issues::capabilities(),
                    "configured": true, "detail": null})),
            }
        }
        let mut entries: Vec<Value> = Vec::new();
        let mut errors: Vec<Value> = Vec::new();
        let mut next_cursors = Map::new();
        for (key, project) in &scopes {
            if continuing.is_some_and(|c| !c.contains_key(key)) {
                continue;
            }
            let cursor = continuing.and_then(|c| c.get(key)).cloned();
            let page = async {
                let client =
                    self.client(project, "listIssues")
                        .await
                        .map_err(|_| TrackerError {
                            operation: "listIssues".into(),
                            reason: "unauthenticated",
                            detail: "GitHub authentication is unavailable. Sign in and retry."
                                .into(),
                        })?;
                let viewer = if involvement == "all" {
                    None
                } else {
                    match viewers.get(&project.host).and_then(Value::as_str) {
                        Some(viewer) => Some(viewer.to_owned()),
                        None => Some(client.issue_viewer().await?),
                    }
                };
                let mut request = json!({"scope": project.repository,
                    "state": input["state"].as_str().unwrap_or("open"),
                    "involvement": involvement, "limit": limit,
                    "sort": input["sort"].as_str().unwrap_or("updated")});
                for field in ["query", "labels", "assignee"] {
                    if let Some(value) = input.get(field) {
                        request[field] = value.clone();
                    }
                }
                if let Some(cursor) = &cursor {
                    request["cursor"] = cursor.clone();
                }
                let page = client.list_issues(&request, viewer.as_deref()).await?;
                Ok::<_, TrackerError>((viewer, page))
            }
            .await;
            match page {
                Ok((viewer, page)) => {
                    if let Some(viewer) = viewer {
                        viewers.insert(project.host.clone(), json!(viewer));
                    }
                    for item in array(page.get("items")) {
                        let mut entry = item.clone();
                        if let Some(map) = entry.as_object_mut() {
                            map.insert("tracker".into(), json!("github"));
                            map.insert("host".into(), json!(project.host));
                            map.insert("scope".into(), json!(project.repository));
                            map.insert("projectId".into(), json!(project.id));
                            map.insert("projectTitle".into(), json!(project.title));
                        }
                        entries.push(entry);
                    }
                    if let Some(next) = page.get("nextCursor").filter(|c| !c.is_null()) {
                        next_cursors.insert(key.clone(), next.clone());
                    }
                }
                Err(failure) => {
                    if let Some(cursor) = cursor {
                        next_cursors.insert(key.clone(), cursor);
                    }
                    if unusable(&failure)
                        && let Some(tracker) = trackers
                            .iter_mut()
                            .find(|t| t["host"] == project.host.as_str())
                    {
                        tracker["configured"] = json!(false);
                        tracker["detail"] = json!(tracker_detail(&failure));
                    }
                    errors.push(
                        json!({"projectId": project.id, "projectTitle": project.title,
                        "message": tracker_detail(&failure)}),
                    );
                }
            }
        }
        entries.sort_by(|a, b| text(b, "updatedAt").cmp(text(a, "updatedAt")));
        Ok(json!({
            "viewers": viewers, "trackers": trackers, "entries": entries, "errors": errors,
            "nextCursors": next_cursors,
            "scopes": scopes.iter().map(|(_, p)| json!({"projectId": p.id, "tracker": "github",
                "host": p.host, "scope": p.repository})).collect::<Vec<_>>(),
        }))
    }

    /// `listLinkedIssueThreads`.
    async fn issue_linked_threads(&self, input: &Value) -> Result<Value, Failure> {
        let failed = || operation("linkedThreads", "Could not load linked threads.", None);
        let active = self.engine.shell_snapshot().await.map_err(|_| failed())?;
        let archived = self
            .engine
            .call("orchestration.getArchivedShellSnapshot", json!({}))
            .await
            .map_err(|_| failed())?;
        let wanted = issue_key(input);
        let mut threads: Vec<&Value> = array(active.get("threads"))
            .iter()
            .chain(array(archived.get("threads")))
            .filter(|t| {
                t.pointer("/lineage/sideChat") != Some(&Value::Bool(true))
                    && t["deletedAt"].is_null()
                    && array(t.get("issues"))
                        .iter()
                        .any(|l| issue_key(l) == wanted)
            })
            .collect();
        threads.sort_by(|a, b| {
            text(b, "updatedAt")
                .cmp(text(a, "updatedAt"))
                .then_with(|| text(a, "id").cmp(text(b, "id")))
        });
        let threads: Vec<Value> = threads
            .into_iter()
            .map(|t| {
                let settled = t.get("settledAt").is_some_and(|v| !v.is_null())
                    || t["settledOverride"] == "settled";
                json!({"id": t["id"], "projectId": t["projectId"], "title": t["title"],
                    "archivedAt": t.get("archivedAt").cloned().unwrap_or(Value::Null),
                    "settled": settled})
            })
            .collect();
        Ok(json!({"threads": threads}))
    }

    /// `resolveUrl`: `https://<host>/<owner>/<name>/issues/<n>`, served through the project that
    /// checks out that repository (preferring `preferredProjectId`), else read-only through a
    /// project on the same host.
    async fn issue_resolve_url(&self, input: &Value) -> Result<Value, Failure> {
        let not_issue = || {
            operation(
                "resolveUrl",
                "This is not a recognised issue URL.",
                Some("not-found"),
            )
        };
        let url = url::Url::parse(text(input, "url").trim()).map_err(|_| not_issue())?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(not_issue());
        }
        let host = url.host_str().ok_or_else(not_issue)?.to_lowercase();
        let parts: Vec<&str> = url
            .path_segments()
            .map(|s| s.filter(|p| !p.is_empty()).collect())
            .unwrap_or_default();
        let (Some(owner), Some(name), Some(&"issues"), Some(number), None) = (
            parts.first(),
            parts.get(1),
            parts.get(2),
            parts.get(3),
            parts.get(4),
        ) else {
            return Err(not_issue());
        };
        if !number.bytes().all(|b| b.is_ascii_digit()) || number.starts_with('0') {
            return Err(not_issue());
        }
        let scope = format!("{owner}/{name}");
        let on_host = self
            .projects(&json!({"host": host}))
            .await
            .map_err(|_| operation("listProjects", "The project list could not be read.", None))?;
        let preferred = input.get("preferredProjectId");
        let prefer = |list: Vec<&Project>| -> Option<Project> {
            list.iter()
                .find(|p| preferred.is_some_and(|id| id == p.id.as_str()))
                .or_else(|| list.first())
                .map(|p| (*p).clone())
        };
        let own = prefer(
            on_host
                .iter()
                .filter(|p| p.repository.eq_ignore_ascii_case(&scope))
                .collect(),
        );
        let writable = own.is_some();
        let lender = own
            .or_else(|| prefer(on_host.iter().collect()))
            .ok_or_else(|| unavailable("tracker-unsupported"))?;
        let scope = if writable {
            lender.repository.clone()
        } else {
            scope
        };
        Ok(
            json!({"projectId": lender.id, "tracker": "github", "host": lender.host,
            "scope": scope, "key": number, "writable": writable}),
        )
    }
}
