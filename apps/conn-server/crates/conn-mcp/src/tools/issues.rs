//! The issue tools: `list_issues`, `read_issue`, `create_issue`, `comment_on_issue`,
//! `set_issue_state`, `link_issue`, `unlink_issue`, `list_thread_issues`
//! (`apps/server/src/mcp/toolkits/issues/handlers.ts`). Issue reads and writes go through the
//! server's GitHub panel (`McpConfig::pull_requests`, operation `issues`); links are the engine's
//! `thread.issue.link` and `thread.issue.unlink`.

use serde_json::{Map, Value, json};

use super::{Args, Cx, ToolError, ToolResult};

fn message(text: &str) -> ToolError {
    ToolError::Message(text.to_owned())
}

/// `requireMcpCapability("issues")`: thread credentials carry it; OAuth clients do not.
fn require_capability(cx: &Cx<'_>) -> Result<(), ToolError> {
    match cx.caller {
        crate::Caller::Thread(_) => Ok(()),
        crate::Caller::Client(_) => Err(message(
            "MCP credential does not grant the issues capability.",
        )),
    }
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// The message of an `IssueError`, as its class renders it.
fn issue_error(error: &Value) -> ToolError {
    let text = match error["_tag"].as_str() {
        Some("IssueUnavailableError") => match error["reason"].as_str() {
            Some("tool-missing") => {
                "The tool this tracker is read through is not installed or set up.".to_owned()
            }
            Some("unauthenticated") => "This tracker has no working credentials.".to_owned(),
            _ => "Issues cannot be browsed for this project yet.".to_owned(),
        },
        Some("IssueOperationError") => format!(
            "Issue operation {} failed: {}",
            text(error, "operation"),
            text(error, "detail")
        ),
        _ => error["message"]
            .as_str()
            .unwrap_or("An error occurred")
            .to_owned(),
    };
    ToolError::Message(text)
}

/// `threadIssueKeyOf`.
fn issue_key(link: &Value) -> (String, String, String, String) {
    let field = |key: &str| text(link, key).trim().to_owned();
    (
        field("tracker"),
        field("host").to_lowercase(),
        field("scope").to_lowercase(),
        field("key"),
    )
}

/// A resolved reference: project, tracker, host, scope, key, the URL given, and whether it
/// may be written.
struct Target {
    reference: Map<String, Value>,
    url: Option<String>,
}

impl Target {
    fn identity(&self) -> Map<String, Value> {
        let mut out = self.reference.clone();
        if let Some(url) = &self.url {
            out.insert("url".into(), json!(url));
        }
        out
    }
}

impl Cx<'_> {
    async fn issues(&self, method: &str, input: Value) -> Result<Value, ToolError> {
        let host = self
            .config()
            .pull_requests
            .clone()
            .ok_or_else(|| message("Issues cannot be browsed for this project yet."))?;
        host("issues", json!({"method": method, "input": input}))
            .await
            .map_err(|error| issue_error(&error))
    }

    /// The caller's own thread, when it has one and it can be read.
    async fn issue_caller_thread(&self) -> Option<Value> {
        let id = self.caller_thread_id()?;
        self.projection(id).await.ok().map(|p| p["thread"].clone())
    }

    /// `requireThread`.
    async fn issue_thread(&self, requested: Option<&str>) -> Result<Value, ToolError> {
        let Some(id) = requested.or(self.caller_thread_id()).map(str::to_owned) else {
            return Err(message(
                "Pass threadId: this MCP client is not running inside a Conn thread.",
            ));
        };
        self.projection(&id)
            .await
            .map(|p| p["thread"].clone())
            .map_err(|_| message(&format!("Thread {id} was not found.")))
    }

    /// `requireProjectScope`: the named project's tracker, or the caller's thread's.
    async fn issue_scope(&self, requested: Option<&Value>) -> Result<Value, ToolError> {
        let project = match requested.filter(|p| p.is_string()) {
            Some(project) => project.clone(),
            None => match self.issue_caller_thread().await {
                Some(thread) => thread["projectId"].clone(),
                None => {
                    return Err(message(
                        "Pass projectId: this MCP client is not running inside a Conn thread.",
                    ));
                }
            },
        };
        self.issues("projectScope", json!({"projectId": project}))
            .await
            .map_err(|_| {
                message(&format!(
                    "Project {} was not found or has no issue tracker.",
                    project.as_str().unwrap_or_default()
                ))
            })
    }

    /// `resolveTarget`: a URL through the project that checks it out, or a key in the named
    /// project's (or the caller's thread's) tracker.
    async fn issue_target(&self, args: &Args, project: Option<Value>) -> Result<Target, ToolError> {
        if let Some(url) = args.get("url").and_then(Value::as_str) {
            let preferred = match project.or_else(|| args.get("projectId").cloned()) {
                Some(project) => project,
                None => self
                    .issue_caller_thread()
                    .await
                    .map(|t| t["projectId"].clone())
                    .unwrap_or(Value::Null),
            };
            let resolved = self
                .issues(
                    "resolveUrl",
                    json!({"url": url, "preferredProjectId": preferred}),
                )
                .await?;
            let mut reference = Map::new();
            for field in ["projectId", "tracker", "host", "scope", "key"] {
                reference.insert(field.into(), resolved[field].clone());
            }
            return Ok(Target {
                reference,
                url: Some(url.to_owned()),
            });
        }
        let Some(key) = args.get("key") else {
            return Err(message(
                "Pass either url, or key (with projectId when not running inside a Conn thread).",
            ));
        };
        let scope = self
            .issue_scope(project.as_ref().or(args.get("projectId")))
            .await?;
        let mut reference = Map::new();
        for field in ["projectId", "tracker", "host", "scope"] {
            reference.insert(field.into(), scope[field].clone());
        }
        reference.insert("key".into(), key.clone());
        Ok(Target {
            reference,
            url: None,
        })
    }
}

pub(crate) async fn list(cx: &Cx<'_>, args: &Args) -> ToolResult {
    require_capability(cx)?;
    let scope = cx.issue_scope(args.get("projectId")).await?;
    let mut input = json!({"projectId": scope["projectId"],
        "state": args.get("state").cloned().unwrap_or(json!("open"))});
    for field in ["query", "limit", "cursors"] {
        if let Some(value) = args.get(field) {
            input[field] = value.clone();
        }
    }
    let result = cx.issues("list", input).await?;
    let issues: Vec<Value> = result["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|entry| {
            let logins = |key: &str, field: &str| -> Vec<Value> {
                entry[key]
                    .as_array()
                    .map(|list| list.iter().map(|a| a[field].clone()).collect())
                    .unwrap_or_default()
            };
            json!({
                "projectId": entry["projectId"], "tracker": entry["tracker"],
                "host": entry["host"], "scope": entry["scope"], "key": entry["key"],
                "url": entry["url"], "displayKey": entry["displayKey"], "title": entry["title"],
                "state": entry["state"],
                "author": entry["author"].get("login").cloned().unwrap_or(Value::Null),
                "assignees": logins("assignees", "login"), "labels": logins("labels", "name"),
                "updatedAt": entry["updatedAt"], "commentCount": entry["commentCount"],
            })
        })
        .collect();
    let errors: Vec<Value> = result["errors"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|e| json!({"projectId": e["projectId"], "message": e["message"]}))
        .collect();
    Ok(json!({"issues": issues, "nextCursors": result["nextCursors"], "errors": errors}))
}

pub(crate) async fn read(cx: &Cx<'_>, args: &Args) -> ToolResult {
    require_capability(cx)?;
    let target = cx.issue_target(args, None).await?;
    let detail = cx
        .issues("detail", Value::Object(target.reference.clone()))
        .await?;
    let logins = |key: &str, field: &str| -> Vec<Value> {
        detail[key]
            .as_array()
            .map(|list| list.iter().map(|a| a[field].clone()).collect())
            .unwrap_or_default()
    };
    let mut out = target.identity();
    let fields = json!({
        "url": target.url.clone().map_or_else(|| detail["url"].clone(), Value::from),
        "displayKey": detail["displayKey"], "title": detail["title"], "state": detail["state"],
        "writable": detail["writable"], "capabilities": detail["capabilities"],
        "states": detail["states"],
        "author": detail["author"].get("login").cloned().unwrap_or(Value::Null),
        "assignees": logins("assignees", "login"), "labels": logins("labels", "name"),
        "createdAt": detail["createdAt"], "updatedAt": detail["updatedAt"],
        "closedAt": detail["closedAt"], "body": detail["body"],
        "comments": detail["comments"].as_array().into_iter().flatten().map(|c| json!({
            "id": c["id"], "author": c["author"].get("login").cloned().unwrap_or(Value::Null),
            "body": c["body"], "createdAt": c["createdAt"]})).collect::<Vec<_>>(),
        "commentsTruncated": !detail["commentsCursor"].is_null(),
        "linkedPullRequests": detail["linkedPullRequests"].as_array().into_iter().flatten()
            .map(|p| json!({"url": p["url"], "title": p["title"], "state": p["state"],
                "closesIssue": p["closesIssue"]})).collect::<Vec<_>>(),
    });
    if let Value::Object(fields) = fields {
        out.extend(fields);
    }
    Ok(Value::Object(out))
}

pub(crate) async fn create(cx: &Cx<'_>, args: &Args) -> ToolResult {
    require_capability(cx)?;
    cx.writing_caller().await?;
    cx.assert_not_linked("start work here that is not its link's")
        .await?;
    let scope = cx.issue_scope(args.get("projectId")).await?;
    let mut input = scope.clone();
    input["title"] = args.get("title").cloned().unwrap_or(Value::Null);
    input["body"] = args.get("body").cloned().unwrap_or(json!(""));
    input["labels"] = args.get("labels").cloned().unwrap_or(json!([]));
    input["assignees"] = args.get("assignees").cloned().unwrap_or(json!([]));
    let created = cx.issues("create", input).await?;
    let mut out = scope.as_object().cloned().unwrap_or_default();
    out.insert("key".into(), created["key"].clone());
    out.insert("url".into(), created["url"].clone());
    out.insert("displayKey".into(), created["displayKey"].clone());
    Ok(Value::Object(out))
}

pub(crate) async fn comment(cx: &Cx<'_>, args: &Args) -> ToolResult {
    require_capability(cx)?;
    cx.writing_caller().await?;
    cx.assert_not_linked("start work here that is not its link's")
        .await?;
    let target = cx.issue_target(args, None).await?;
    let mut input = target.reference.clone();
    input.insert(
        "body".into(),
        args.get("body").cloned().unwrap_or(Value::Null),
    );
    cx.issues("comment", Value::Object(input)).await?;
    Ok(Value::Object(target.identity()))
}

pub(crate) async fn set_state(cx: &Cx<'_>, args: &Args) -> ToolResult {
    require_capability(cx)?;
    cx.writing_caller().await?;
    cx.assert_not_linked("start work here that is not its link's")
        .await?;
    let target = cx.issue_target(args, None).await?;
    let mut input = target.reference.clone();
    input.insert(
        "state".into(),
        args.get("state").cloned().unwrap_or(Value::Null),
    );
    cx.issues("setState", Value::Object(input)).await?;
    Ok(Value::Object(target.identity()))
}

pub(crate) async fn link(cx: &Cx<'_>, args: &Args) -> ToolResult {
    require_capability(cx)?;
    cx.writes_threads(&[args.get("threadId").and_then(Value::as_str)])
        .await?;
    let thread = cx
        .issue_thread(args.get("threadId").and_then(Value::as_str))
        .await?;
    let target = cx
        .issue_target(
            args,
            Some(
                args.get("projectId")
                    .cloned()
                    .unwrap_or_else(|| thread["projectId"].clone()),
            ),
        )
        .await?;
    // Reading the issue proves it exists and names it for the thread's row.
    let detail = cx
        .issues("detail", Value::Object(target.reference.clone()))
        .await?;
    let url = target
        .url
        .clone()
        .map_or_else(|| detail["url"].clone(), Value::from);
    let key = issue_key(&Value::Object(target.reference.clone()));
    let already = thread["issues"]
        .as_array()
        .is_some_and(|links| links.iter().any(|l| issue_key(l) == key));
    if !already {
        let thread_id = text(&thread, "id").to_owned();
        let mut command = target.reference.clone();
        command.insert("type".into(), json!("thread.issue.link"));
        command.insert(
            "commandId".into(),
            json!(format!(
                "server:thread-issue-link:{thread_id}:{}",
                conn_support::uuid_v4()
            )),
        );
        command.insert("threadId".into(), json!(thread_id));
        command.insert("url".into(), url.clone());
        command.insert("displayKey".into(), detail["displayKey"].clone());
        command.insert("title".into(), detail["title"].clone());
        command.insert("source".into(), json!("agent"));
        cx.dispatch(Value::Object(command))
            .await
            .map_err(|_| message("Could not change the issue link."))?;
    }
    let mut out = target.identity();
    out.insert("url".into(), url);
    out.insert("alreadyLinked".into(), json!(already));
    Ok(Value::Object(out))
}

pub(crate) async fn unlink(cx: &Cx<'_>, args: &Args) -> ToolResult {
    require_capability(cx)?;
    cx.writes_threads(&[args.get("threadId").and_then(Value::as_str)])
        .await?;
    let thread = cx
        .issue_thread(args.get("threadId").and_then(Value::as_str))
        .await?;
    let target = cx
        .issue_target(
            args,
            Some(
                args.get("projectId")
                    .cloned()
                    .unwrap_or_else(|| thread["projectId"].clone()),
            ),
        )
        .await?;
    let key = issue_key(&Value::Object(target.reference.clone()));
    let existing = thread["issues"]
        .as_array()
        .and_then(|links| links.iter().find(|l| issue_key(l) == key).cloned());
    let mut out = target.identity();
    let Some(existing) = existing else {
        out.insert("wasLinked".into(), json!(false));
        return Ok(Value::Object(out));
    };
    let thread_id = text(&thread, "id").to_owned();
    let mut command = Map::new();
    command.insert("type".into(), json!("thread.issue.unlink"));
    command.insert(
        "commandId".into(),
        json!(format!(
            "server:thread-issue-unlink:{thread_id}:{}",
            conn_support::uuid_v4()
        )),
    );
    command.insert("threadId".into(), json!(thread_id));
    for field in ["tracker", "host", "scope", "key"] {
        command.insert(field.into(), target.reference[field].clone());
    }
    cx.dispatch(Value::Object(command))
        .await
        .map_err(|_| message("Could not change the issue link."))?;
    out.insert("url".into(), existing["url"].clone());
    out.insert("wasLinked".into(), json!(true));
    Ok(Value::Object(out))
}

pub(crate) async fn list_thread(cx: &Cx<'_>, args: &Args) -> ToolResult {
    require_capability(cx)?;
    let thread = cx
        .issue_thread(args.get("threadId").and_then(Value::as_str))
        .await?;
    let issues: Vec<Value> = thread["issues"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|l| {
            json!({"projectId": l["projectId"], "tracker": l["tracker"], "host": l["host"],
                "scope": l["scope"], "key": l["key"], "url": l["url"], "source": l["source"],
                "displayKey": l["displayKey"], "title": l["title"]})
        })
        .collect();
    Ok(json!({ "issues": issues }))
}
