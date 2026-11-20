//! The forge tools on a thread's pull request: `pull_request_read`, `pull_request_list`,
//! `pull_request_create`, `pull_request_update`, `pull_request_respond`, `pull_request_review`,
//! `pull_request_merge`,
//! `ci_logs` and `ci_rerun` (`apps/server/src/mcp/toolkits/pullRequests/handlers.ts`). The
//! thread, its project and the target are found here, as the toolkit's `locate`; every host
//! read and write goes through the server's GitHub panel (`McpConfig::pull_requests`).
//!
//! `pull_request_create` runs `GitManager.createPullRequest` on the server
//! (`conn_source_control::pull_requests::create`) and links what it opened.

use serde_json::{Map, Value, json};

use super::pull_requests::{
    Target, contract_message, links_of, message, project_identity, project_not_found,
    resolve_target, text,
};
use super::{Args, Cx, ToolError, ToolResult};
use conn_source_control::registry;

const BRANCH_HAS_NONE: &str =
    "This thread's branch has no known PR. Pass number, or open one with pull_request_create.";
const CURSOR_INVALID: &str =
    "This cursor is not from this tool. Pass a nextCursor from its last result.";
/// Keeps one conversation page near the size of a capped CI log (UTF-16 units of its JSON).
const CONVERSATION_PAGE_CHARS: usize = 32_000;
const THREAD_COMMENT_PAGES: usize = 4;

/// A thread's pull request, found by `locate`.
struct Located {
    thread: Value,
    target: Target,
    /// `PullRequestRef`: the project and the target's host, repository and number.
    reference: Map<String, Value>,
}

impl Located {
    fn identity(&self) -> Map<String, Value> {
        self.target.json()
    }

    fn with(&self, extra: Value) -> Value {
        let mut input = self.reference.clone();
        if let Value::Object(fields) = extra {
            input.extend(fields);
        }
        Value::Object(input)
    }
}

/// A host failure, as `PullRequestForgeError` renders it: the failure's own message.
fn forge(error: &Value) -> ToolError {
    if error["_tag"] == "PullRequestForgeError" {
        return ToolError::Message(
            error["detail"]
                .as_str()
                .unwrap_or("Could not read this thread's project.")
                .to_owned(),
        );
    }
    ToolError::Message(contract_message(error))
}

fn unavailable() -> Value {
    json!({"_tag": "PullRequestUnavailableError", "reason": "provider-unsupported"})
}

impl Cx<'_> {
    /// One panel operation; a missing panel answers as T3 does when no host can be read.
    async fn forge_call(&self, operation: &'static str, input: Value) -> Result<Value, ToolError> {
        self.pull_request_host(operation, input)
            .await
            .unwrap_or_else(|| Err(unavailable()))
            .map_err(|error| forge(&error))
    }

    async fn panel(&self, method: &str, input: Value) -> Result<Value, ToolError> {
        self.forge_call("call", json!({"method": method, "input": input}))
            .await
    }

    async fn fresh(&self, method: &str, mut input: Value) -> Result<Value, ToolError> {
        input["method"] = json!(method);
        self.forge_call("fresh", input).await
    }

    /// `locate`: the calling thread's checkout, its project, and the PR the input names
    /// (default: the branch's PR).
    async fn locate(&self, input: &Args) -> Result<Located, ToolError> {
        let thread = self.pull_request_thread(&Args::new()).await?;
        let Some(project) = self.project_of(&thread).await else {
            return Err(message(&project_not_found(
                input
                    .get("repository")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            )));
        };
        let branch_pull_request = thread
            .get("branchPullRequest")
            .filter(|value| !value.is_null());
        // Status sync sets branchPullRequest later, so a PR this thread just opened counts too,
        // unless it is another branch's.
        let opened = if branch_pull_request.is_none() {
            links_of(&thread).into_iter().rev().find(|link| {
                link["source"] == "created"
                    && (link["snapshot"].is_null()
                        || link["snapshot"]["headBranch"] == thread["branch"])
            })
        } else {
            None
        };
        let branch = branch_pull_request.cloned().or_else(|| opened.clone());
        let branch_repository = project_identity(Some(&project))
            .and_then(|identity| registry::repository_selector(&identity));
        let mut named = Args::new();
        if let Some(number) = input.get("number") {
            named.insert("number".into(), number.clone());
            if let Some(repository) = input
                .get("repository")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or(branch_repository)
            {
                named.insert("repository".into(), json!(repository));
            }
        } else if let Some(branch) = &branch {
            named.insert("number".into(), branch["number"].clone());
            named.insert("repository".into(), branch["repository"].clone());
        } else {
            return Err(message(BRANCH_HAS_NONE));
        }
        let target = resolve_target(&named, Some(&project))?;
        let mut reference = Map::new();
        reference.insert("projectId".into(), project["id"].clone());
        reference.insert("host".into(), json!(target.key.host));
        reference.insert("repository".into(), json!(target.key.repository));
        reference.insert("number".into(), json!(target.key.number));
        let located = Located {
            thread,
            target,
            reference,
        };
        if input.get("number").is_none()
            && opened
                .as_ref()
                .is_some_and(|link| link["snapshot"].is_null())
        {
            // Not synced yet, so only the host knows which branch it was opened from.
            let summary = self.fresh("summary", located.with(json!({}))).await?;
            if summary["headBranch"] != located.thread["branch"] {
                return Err(message(BRANCH_HAS_NONE));
            }
        }
        Ok(located)
    }

    async fn forge_writer(&self) -> Result<(), ToolError> {
        self.writing_caller().await?;
        self.assert_not_linked("start work here that is not its link's")
            .await
    }
}

// ---- Cursors ------------------------------------------------------------------------------

/// `Base64Url.encode` of the cursor's JSON.
fn encode_cursor(value: &Value) -> String {
    conn_support::base64::url_encode(value.to_string().as_bytes())
}

fn decode_cursor(cursor: &str) -> Result<Value, ToolError> {
    conn_support::base64::url_decode(cursor)
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .ok_or_else(|| message(CURSOR_INVALID))
}

/// `TrimmedNonEmptyString` decoded: the text trimmed, if anything is left.
fn trimmed_non_empty(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn non_negative_int(value: &Value) -> bool {
    value.as_u64().is_some()
        || value
            .as_f64()
            .is_some_and(|n| n >= 0.0 && n.fract() == 0.0 && n <= 9_007_199_254_740_991.0)
}

/// `ReadCursor`: `{diff}` or `{threads, comments, includeResolved}`.
enum ReadCursor {
    Diff(String),
    Conversation {
        threads: usize,
        comments: usize,
        include_resolved: bool,
    },
}

fn read_cursor(cursor: &str) -> Result<ReadCursor, ToolError> {
    let value = decode_cursor(cursor)?;
    if let Some(diff) = value.get("diff").and_then(trimmed_non_empty) {
        return Ok(ReadCursor::Diff(diff));
    }
    let index = |key: &str| {
        value
            .get(key)
            .filter(|v| non_negative_int(v))
            .and_then(Value::as_f64)
            .map(|n| n as usize)
    };
    match (
        index("threads"),
        index("comments"),
        value.get("includeResolved"),
    ) {
        (Some(threads), Some(comments), Some(Value::Bool(include_resolved))) => {
            Ok(ReadCursor::Conversation {
                threads,
                comments,
                include_resolved: *include_resolved,
            })
        }
        _ => Err(message(CURSOR_INVALID)),
    }
}

/// `PullRequestListCursors` decoded: keys and values trimmed and non-empty, values at most
/// 4,096 units after trimming.
fn list_cursors(cursor: &str) -> Result<Value, ToolError> {
    let value = decode_cursor(cursor)?;
    let Some(map) = value.as_object() else {
        return Err(message(CURSOR_INVALID));
    };
    let mut out = Map::new();
    for (key, value) in map {
        let key = key.trim();
        let value = trimmed_non_empty(value).filter(|v| v.encode_utf16().count() <= 4096);
        match value {
            Some(value) if !key.is_empty() => {
                out.insert(key.to_owned(), json!(value));
            }
            _ => return Err(message(CURSOR_INVALID)),
        }
    }
    Ok(Value::Object(out))
}

// ---- pull_request_read --------------------------------------------------------------------

fn js_length(value: &Value) -> usize {
    value.to_string().encode_utf16().count()
}

struct Page {
    threads: Vec<Value>,
    comments: Vec<Value>,
    hidden_resolved: usize,
    next: Option<Value>,
}

/// `conversationPage`: review threads first, then comments, near 32,000 characters.
fn conversation_page(
    activity: &Value,
    start_threads: usize,
    start_comments: usize,
    include_resolved: bool,
) -> Page {
    let empty = Vec::new();
    let threads = activity["reviewThreads"].as_array().unwrap_or(&empty);
    let comments = activity["comments"].as_array().unwrap_or(&empty);
    let mut page_threads = Vec::new();
    let mut page_comments = Vec::new();
    let mut size = 0;
    let mut thread = start_threads.min(threads.len());
    let mut comment = start_comments.min(comments.len());
    let mut fits = |item: &Value, taken: usize| {
        let next = size + js_length(item);
        if next > CONVERSATION_PAGE_CHARS && taken > 0 {
            return false;
        }
        size = next;
        true
    };
    while let Some(next) = threads.get(thread) {
        if include_resolved || next["isResolved"] != true {
            if !fits(next, page_threads.len() + page_comments.len()) {
                break;
            }
            page_threads.push(next.clone());
        }
        thread += 1;
    }
    if thread == threads.len() {
        while let Some(next) = comments.get(comment) {
            if !fits(next, page_threads.len() + page_comments.len()) {
                break;
            }
            page_comments.push(next.clone());
            comment += 1;
        }
    }
    let done = thread == threads.len() && comment == comments.len();
    Page {
        threads: page_threads,
        comments: page_comments,
        hidden_resolved: if include_resolved {
            0
        } else {
            threads.iter().filter(|t| t["isResolved"] == true).count()
        },
        next: (!done).then(
            || json!({"threads": thread, "comments": comment, "includeResolved": include_resolved}),
        ),
    }
}

fn login(actor: &Value) -> Value {
    actor
        .get("login")
        .filter(|l| l.is_string())
        .cloned()
        .unwrap_or(Value::Null)
}

fn or_null(value: &Value, key: &str) -> Value {
    value.get(key).cloned().unwrap_or(Value::Null)
}

impl Cx<'_> {
    /// `restOfThread`: a thread's comments past its first page, up to four more pages.
    async fn rest_of_thread(&self, located: &Located, thread: &Value) -> (Vec<Value>, bool) {
        let mut comments = Vec::new();
        let mut cursor = thread
            .get("nextCommentsCursor")
            .and_then(Value::as_str)
            .map(str::to_owned);
        for _ in 0..THREAD_COMMENT_PAGES {
            let Some(current) = cursor.take() else {
                break;
            };
            let read = self
                .panel(
                    "threadComments",
                    located.with(json!({"threadId": thread["id"], "cursor": current})),
                )
                .await;
            let Ok(read) = read else {
                cursor = Some(current);
                break;
            };
            if let Some(more) = read["comments"].as_array() {
                comments.extend(more.iter().cloned());
            }
            cursor = read["nextCursor"].as_str().map(str::to_owned);
        }
        (comments, cursor.is_some())
    }
}

pub(crate) async fn read(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let cursor = match args.get("cursor").and_then(Value::as_str) {
        Some(cursor) => Some(read_cursor(cursor)?),
        None => None,
    };
    let located = cx.locate(args).await?;
    // A cursor continues the one section it came from, with that read's options.
    let sections: Vec<String> = match &cursor {
        Some(ReadCursor::Diff(_)) => vec!["diff".into()],
        Some(ReadCursor::Conversation { .. }) => vec!["conversation".into()],
        None => args
            .get("sections")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_else(|| vec!["summary".into(), "checks".into()]),
    };
    let wants = |section: &str| sections.iter().any(|s| s == section);
    let include_resolved = match &cursor {
        Some(ReadCursor::Conversation {
            include_resolved, ..
        }) => *include_resolved,
        _ => args.get("includeResolved") == Some(&Value::Bool(true)),
    };
    // Agents pin merges to this headSha, so it must not come from a stale snapshot.
    let detail = if wants("summary") || wants("checks") {
        Some(cx.fresh("detail", located.with(json!({}))).await?)
    } else {
        None
    };
    let activity = if wants("conversation") {
        Some(cx.panel("activity", located.with(json!({}))).await?)
    } else {
        None
    };
    let diff = if wants("diff") {
        let extra = match &cursor {
            Some(ReadCursor::Diff(at)) => json!({"cursor": at}),
            _ => json!({}),
        };
        Some(cx.panel("diff", located.with(extra)).await?)
    } else {
        None
    };
    let mut result = located.identity();
    if let Some(detail) = &detail {
        if wants("summary") {
            let names = |key: &str, field: &str| -> Vec<Value> {
                detail[key]
                    .as_array()
                    .map(|list| list.iter().map(|item| item[field].clone()).collect())
                    .unwrap_or_default()
            };
            result.insert(
                "summary".into(),
                json!({
                    "title": detail["title"], "body": detail["body"], "state": detail["state"],
                    "isDraft": detail["isDraft"], "author": login(&detail["author"]),
                    "headBranch": detail["headBranch"], "baseBranch": detail["baseBranch"],
                    "headSha": or_null(detail, "headSha"), "mergeability": detail["mergeability"],
                    "behindBy": or_null(detail, "behindBy"),
                    "autoMergeEnabled": or_null(detail, "autoMergeEnabled"),
                    "additions": detail["additions"], "deletions": detail["deletions"],
                    "changedFiles": detail["changedFiles"], "labels": names("labels", "name"),
                    "reviewers": names("reviewers", "login"),
                }),
            );
        }
        if wants("checks") {
            result.insert("checks".into(), or_null(detail, "checks"));
        }
    }
    if let Some(activity) = &activity {
        let (threads, comments) = match &cursor {
            Some(ReadCursor::Conversation {
                threads, comments, ..
            }) => (*threads, *comments),
            _ => (0, 0),
        };
        let page = conversation_page(activity, threads, comments, include_resolved);
        let mut review_threads = Vec::with_capacity(page.threads.len());
        for thread in &page.threads {
            let (rest, more) = cx.rest_of_thread(&located, thread).await;
            let comments: Vec<Value> = thread["comments"]
                .as_array()
                .into_iter()
                .flatten()
                .chain(rest.iter())
                .map(|comment| {
                    json!({"author": login(&comment["author"]), "body": comment["body"],
                        "createdAt": comment["createdAt"]})
                })
                .collect();
            review_threads.push(json!({
                "id": thread["id"], "path": thread["path"], "line": or_null(thread, "line"),
                "isResolved": thread["isResolved"], "isOutdated": thread["isOutdated"],
                "comments": comments, "moreComments": more,
            }));
        }
        let comments: Vec<Value> = page
            .comments
            .iter()
            .map(|comment| {
                json!({"id": comment["id"], "kind": comment["kind"],
                    "author": login(&comment["author"]), "body": comment["body"],
                    "createdAt": comment["createdAt"], "path": or_null(comment, "path"),
                    "reviewState": or_null(comment, "reviewState")})
            })
            .collect();
        result.insert(
            "conversation".into(),
            json!({
                "comments": comments, "reviewThreads": review_threads,
                "hiddenResolvedThreads": page.hidden_resolved,
                "truncated": activity["commentsTruncated"] == true
                    || activity["reviewThreadsTruncated"] == true,
                "nextCursor": page.next.as_ref().map_or(Value::Null, |next| json!(encode_cursor(next))),
            }),
        );
    }
    if let Some(diff) = &diff {
        result.insert(
            "diff".into(),
            json!({
                "patch": diff["patch"], "truncated": diff["truncated"],
                "nextCursor": diff["nextCursor"].as_str()
                    .map_or(Value::Null, |next| json!(encode_cursor(&json!({"diff": next})))),
            }),
        );
    }
    Ok(Value::Object(result))
}

// ---- pull_request_list --------------------------------------------------------------------

pub(crate) async fn list(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let thread = cx.pull_request_thread(&Args::new()).await?;
    let mut input = json!({
        "projectId": thread["projectId"],
        "state": args.get("state").cloned().unwrap_or(json!("open")),
        "involvement": args.get("involvement").cloned().unwrap_or(json!("all")),
        "limit": args.get("limit").cloned().unwrap_or(json!(30)),
    });
    if let Some(query) = args.get("query") {
        input["query"] = query.clone();
    }
    if let Some(cursor) = args.get("cursor").and_then(Value::as_str) {
        input["cursors"] = list_cursors(cursor)?;
    }
    let listed = cx.panel("list", input).await?;
    let entries = listed["entries"].as_array().cloned().unwrap_or_default();
    if entries.is_empty()
        && let Some(failure) = listed["errors"].as_array().and_then(|e| e.first())
    {
        return Err(ToolError::Message(text(failure, "message").to_owned()));
    }
    let pull_requests: Vec<Value> = entries
        .iter()
        .map(|entry| {
            json!({
                "number": entry["number"], "title": entry["title"], "url": entry["url"],
                "author": login(&entry["author"]), "headBranch": entry["headBranch"],
                "baseBranch": entry["baseBranch"], "state": entry["state"],
                "isDraft": entry["isDraft"], "reviewDecision": or_null(entry, "reviewDecision"),
                "checksState": or_null(entry, "checksState"), "updatedAt": entry["updatedAt"],
            })
        })
        .collect();
    let next = &listed["nextCursors"];
    Ok(json!({
        "pullRequests": pull_requests,
        "truncated": listed["truncated"] == true,
        "nextCursor": if next.as_object().is_none_or(Map::is_empty) {
            Value::Null
        } else {
            json!(encode_cursor(next))
        },
    }))
}

// ---- pull_request_create ------------------------------------------------------------------

const NOT_LISTED_YET: &str =
    "The host accepted the PR but does not list it yet. Find it with pull_request_list.";

/// `pull_request_create`: opens a PR from the thread's pushed branch, or finds the open one,
/// and links it to the thread as `created`.
pub(crate) async fn create(cx: &Cx<'_>, args: &Args) -> ToolResult {
    cx.forge_writer().await?;
    let thread = cx.pull_request_thread(&Args::new()).await?;
    let Some(project) = cx.project_of(&thread).await else {
        return Err(message(&project_not_found("")));
    };
    let cwd = thread
        .get("worktreePath")
        .and_then(Value::as_str)
        .unwrap_or_else(|| text(&project, "workspaceRoot"));
    let mut input = json!({"cwd": cwd, "projectId": project["id"], "title": args.get("title"),
        "body": args.get("body")});
    for key in ["base", "draft"] {
        if let Some(value) = args.get(key) {
            input[key] = value.clone();
        }
    }
    let created = cx.forge_call("createPullRequest", input).await?;
    let Some(url) = created.get("url").and_then(Value::as_str) else {
        return Err(message(NOT_LISTED_YET));
    };
    let mut named = Args::new();
    named.insert("url".into(), json!(url));
    let target = resolve_target(&named, Some(&project))?;
    cx.link_created(&thread, &target).await?;
    let mut result = target.json();
    result.insert("created".into(), json!(created["status"] == "created"));
    super::pull_requests::subagent_next(&thread, &mut result);
    Ok(Value::Object(result))
}

// ---- pull_request_update ------------------------------------------------------------------

impl Cx<'_> {
    /// `reviewerNamed`: a login or org/team matched to the host's own reviewer id.
    async fn reviewer_named(&self, located: &Located, name: &str) -> Result<Value, ToolError> {
        let found = self
            .panel("reviewerCandidates", located.with(json!({"query": name})))
            .await?;
        let wanted = name.to_lowercase();
        found["candidates"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|candidate| {
                text(candidate, "login").to_lowercase() == wanted
                    || text(candidate, "id").to_lowercase() == wanted
            })
            .map(|candidate| json!({"id": candidate["id"], "kind": candidate["kind"]}))
            .ok_or_else(|| {
                message(&format!(
                    "No reviewer named {name} can be requested on this PR."
                ))
            })
    }
}

pub(crate) async fn update(cx: &Cx<'_>, args: &Args) -> ToolResult {
    cx.forge_writer().await?;
    const FIELDS: [&str; 7] = [
        "title",
        "body",
        "ready",
        "state",
        "addLabels",
        "removeLabels",
        "requestReviewers",
    ];
    if FIELDS.iter().all(|key| args.get(*key).is_none()) {
        return Err(message(
            "Pass title, body, ready, state, addLabels, removeLabels, or requestReviewers.",
        ));
    }
    let located = cx.locate(args).await?;
    if args.get("title").is_some() || args.get("body").is_some() {
        let mut fields = Map::new();
        for key in ["title", "body"] {
            if let Some(value) = args.get(key) {
                fields.insert(key.into(), value.clone());
            }
        }
        cx.panel("update", located.with(Value::Object(fields)))
            .await?;
    }
    for (key, applied) in [("addLabels", true), ("removeLabels", false)] {
        if let Some(labels) = args.get(key) {
            cx.panel(
                "setLabels",
                located.with(json!({"labels": labels, "applied": applied})),
            )
            .await?;
        }
    }
    if let Some(names) = args.get("requestReviewers").and_then(Value::as_array) {
        let mut reviewers = Vec::with_capacity(names.len());
        for name in names.iter().filter_map(Value::as_str) {
            reviewers.push(cx.reviewer_named(&located, name).await?);
        }
        cx.panel(
            "requestReviewers",
            located.with(json!({"reviewers": reviewers, "requested": true})),
        )
        .await?;
    }
    if let Some(ready) = args.get("ready").and_then(Value::as_bool) {
        let action = if ready { "ready" } else { "draft" };
        cx.panel("runAction", located.with(json!({"action": action})))
            .await?;
    }
    if let Some(state) = args.get("state").and_then(Value::as_str) {
        let action = if state == "closed" { "close" } else { "reopen" };
        cx.panel("runAction", located.with(json!({"action": action})))
            .await?;
    }
    Ok(Value::Object(located.identity()))
}

// ---- pull_request_respond -----------------------------------------------------------------

pub(crate) async fn respond(cx: &Cx<'_>, args: &Args) -> ToolResult {
    cx.forge_writer().await?;
    let body = args.get("body").and_then(Value::as_str);
    let thread_id = args.get("reviewThreadId").and_then(Value::as_str);
    let resolved = args.get("resolved").and_then(Value::as_bool);
    if body.is_none() && (thread_id.is_none() || resolved.is_none()) {
        return Err(message("Pass body, or reviewThreadId with resolved."));
    }
    if thread_id.is_none() && resolved.is_some() {
        return Err(message("resolved needs reviewThreadId."));
    }
    let located = cx.locate(args).await?;
    if let Some(body) = body {
        match thread_id {
            None => {
                cx.panel("comment", located.with(json!({"body": body})))
                    .await?
            }
            Some(id) => {
                cx.panel(
                    "replyToThread",
                    located.with(json!({"threadId": id, "body": body})),
                )
                .await?
            }
        };
    }
    if let (Some(id), Some(resolved)) = (thread_id, resolved) {
        let set = cx
            .panel(
                "setThreadResolution",
                located.with(json!({"threadId": id, "resolved": resolved})),
            )
            .await;
        if let Err(error) = set {
            // A retry with the body would post the reply twice.
            return Err(match (body, error) {
                (Some(_), ToolError::Message(detail)) => ToolError::Message(format!(
                    "The reply was posted, but setting resolved failed: {detail} Retry without body."
                )),
                (_, error) => error,
            });
        }
    }
    let mut result = located.identity();
    result.insert("replied".into(), json!(body.is_some()));
    result.insert("resolved".into(), json!(resolved));
    Ok(Value::Object(result))
}

// ---- pull_request_review ------------------------------------------------------------------

pub(crate) async fn review(cx: &Cx<'_>, args: &Args) -> ToolResult {
    cx.forge_writer().await?;
    let located = cx.locate(args).await?;
    let comments = args.get("comments").cloned().unwrap_or(json!([]));
    let placed = if comments.as_array().is_none_or(Vec::is_empty) {
        json!([])
    } else {
        cx.forge_call(
            "placeReviewComments",
            located.with(json!({"comments": comments})),
        )
        .await?
    };
    cx.panel(
        "submitReview",
        located.with(json!({"verdict": args.get("verdict"),
            "body": args.get("body").cloned().unwrap_or(json!("")), "comments": placed})),
    )
    .await?;
    Ok(Value::Object(located.identity()))
}

// ---- pull_request_merge -------------------------------------------------------------------

impl Cx<'_> {
    /// `stackMergeScope`: layers below the target pinned to the heads read now.
    async fn stack_merge_scope(&self, located: &Located, args: &Args) -> Result<Value, ToolError> {
        if args.get("auto") == Some(&Value::Bool(true)) {
            return Err(message("A stack merge cannot wait with auto."));
        }
        let number = located.target.key.number;
        let stack = self.fresh("stack", located.with(json!({}))).await?;
        let layers = stack["layers"].as_array().cloned().unwrap_or_default();
        let end = layers.iter().position(|layer| layer["number"] == number);
        let (Some(end), false) = (end, stack.is_null()) else {
            return Err(message(&format!(
                "PR #{number} is not in a stack this host can merge. Merge it without stack."
            )));
        };
        let expected = args.get("expectedHeadSha").cloned().unwrap_or(Value::Null);
        let mut heads = Vec::new();
        for layer in layers.iter().take(end + 1) {
            if layer["state"] == "merged" {
                continue;
            }
            let head = if layer["number"] == number {
                expected.clone()
            } else {
                layer.get("headSha").cloned().unwrap_or(Value::Null)
            };
            if head.is_null() {
                return Err(message(&format!(
                    "The host did not report PR #{}'s head, so the stack cannot be pinned. Try again.",
                    layer["number"]
                )));
            }
            heads.push(json!({"number": layer["number"], "headSha": head}));
        }
        Ok(json!({"stackNumber": stack["number"], "expectedStackHeads": heads}))
    }
}

pub(crate) async fn merge(cx: &Cx<'_>, args: &Args) -> ToolResult {
    cx.forge_writer().await?;
    let located = cx.locate(args).await?;
    let mut action = json!({
        "action": if args.get("auto") == Some(&Value::Bool(true)) { "enable-auto-merge" } else { "merge" },
        "expectedHeadSha": args.get("expectedHeadSha"),
    });
    if let Some(method) = args.get("method") {
        action["mergeMethod"] = method.clone();
    }
    if args.get("stack") == Some(&Value::Bool(true))
        && let Value::Object(scope) = cx.stack_merge_scope(&located, args).await?
    {
        for (key, value) in scope {
            action[key] = value;
        }
    }
    cx.panel("runAction", located.with(action)).await?;
    let after = cx.fresh("summary", located.with(json!({}))).await?;
    let mut result = located.identity();
    result.insert("state".into(), after["state"].clone());
    Ok(Value::Object(result))
}

// ---- ci_logs and ci_rerun -----------------------------------------------------------------

pub(crate) async fn ci_logs(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let located = cx.locate(args).await?;
    let mut extra = json!({"tailLines": args.get("tailLines").cloned().unwrap_or(json!(200))});
    if let Some(check) = args.get("check") {
        extra["check"] = check.clone();
    }
    let checks = cx.forge_call("checkLogs", located.with(extra)).await?;
    let mut result = located.identity();
    result.insert("checks".into(), checks);
    Ok(Value::Object(result))
}

pub(crate) async fn ci_rerun(cx: &Cx<'_>, args: &Args) -> ToolResult {
    cx.forge_writer().await?;
    let located = cx.locate(args).await?;
    let extra = args
        .get("check")
        .map_or_else(|| json!({}), |check| json!({"check": check}));
    let checks = cx.forge_call("rerunChecks", located.with(extra)).await?;
    // Like a push, a rerun makes a watch's finished checks stale, so the thread keeps working
    // until a read sees them run. The rerun already happened, so a failed reopen only logs.
    let rerun = checks
        .as_array()
        .is_some_and(|list| list.iter().any(|check| check["rerun"] == true));
    let watched = links_of(&located.thread).iter().any(|link| {
        link.get("watch")
            .is_some_and(|watch| watch.get("checksPending").is_some())
    });
    if rerun && watched {
        let thread_id = text(&located.thread, "id").to_owned();
        let command = json!({
            "type": "thread.pull-request-watch.checks-reopen",
            "commandId": Cx::pull_request_command_id("mcp-ci-rerun-checks", &thread_id),
            "threadId": thread_id,
        });
        if let Err(error) = cx.dispatch(command).await {
            eprintln!("mcp: reopening a watch's checks after a rerun failed: {error}");
        }
    }
    let mut result = located.identity();
    result.insert("checks".into(), checks);
    Ok(Value::Object(result))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversation_pages_as_t3_does() {
        let thread = |id: &str, resolved: bool| {
            json!({"id": id, "path": "a", "line": 1, "isResolved": resolved, "isOutdated": false,
                "comments": [{"author": null, "body": "x".repeat(20_000), "createdAt": "t"}]})
        };
        let activity = json!({
            "reviewThreads": [thread("1", false), thread("2", true), thread("3", false)],
            "comments": [{"id": "c", "kind": "comment", "author": null, "body": "b", "createdAt": "t"}],
        });
        let first = conversation_page(&activity, 0, 0, false);
        assert_eq!(first.threads.len(), 1, "a second thread does not fit");
        assert_eq!(first.hidden_resolved, 1);
        assert_eq!(
            first.next,
            Some(json!({"threads": 2, "comments": 0, "includeResolved": false})),
            "the resolved one is skipped"
        );
        let second = conversation_page(&activity, 2, 0, false);
        assert_eq!(second.threads.len(), 1);
        assert_eq!(second.comments.len(), 1);
        assert_eq!(second.next, None);
    }

    #[test]
    fn cursors_round_trip_and_refuse_others() {
        let next = json!({"threads": 1, "comments": 0, "includeResolved": true});
        let encoded = encode_cursor(&next);
        assert!(matches!(
            read_cursor(&encoded),
            Ok(ReadCursor::Conversation {
                threads: 1,
                comments: 0,
                include_resolved: true
            })
        ));
        assert!(matches!(
            read_cursor(&encode_cursor(&json!({"diff": "2"}))),
            Ok(ReadCursor::Diff(at)) if at == "2"
        ));
        assert!(matches!(
            read_cursor(&encode_cursor(&json!({"diff": " 2 "}))),
            Ok(ReadCursor::Diff(at)) if at == "2"
        ));
        for bad in ["%%", "e30", &encode_cursor(&json!({"diff": "  "}))] {
            assert!(read_cursor(bad).is_err(), "{bad}");
        }
        assert!(list_cursors(&encode_cursor(&json!({"a": "b"}))).is_ok());
        assert!(list_cursors(&encode_cursor(&json!({"a": ""}))).is_err());
    }
}
