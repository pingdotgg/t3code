//! Engine rows (shell rows, thread projections) shaped as the T3 tool results
//! (`packages/contracts/src/orchestratorMcp.ts`), as `OrchestratorMcpService.ts` builds them.

use serde_json::{Value, json};

use crate::{Caller, McpConfig, links::thread_link};

pub const LIVE_RUN_STATUSES: [&str; 5] = ["preparing", "queued", "starting", "running", "waiting"];

pub fn is_live(run: &Value) -> bool {
    LIVE_RUN_STATUSES.contains(&run["status"].as_str().unwrap_or(""))
}

fn runs(projection: &Value) -> Vec<&Value> {
    let mut runs: Vec<&Value> = projection["runs"]
        .as_array()
        .map(|r| r.iter().collect())
        .unwrap_or_default();
    runs.sort_by_key(|run| run["ordinal"].as_u64().unwrap_or(0));
    runs
}

pub fn latest_run(projection: &Value) -> Option<&Value> {
    runs(projection).pop()
}

pub fn active_run(projection: &Value) -> Option<&Value> {
    runs(projection).into_iter().rev().find(|run| is_live(run))
}

pub fn run_by_id<'a>(projection: &'a Value, run_id: &str) -> Option<&'a Value> {
    projection["runs"]
        .as_array()?
        .iter()
        .find(|run| run["id"] == run_id)
}

fn settled(thread: &Value) -> (bool, Value) {
    let settled = thread["settledOverride"] == "settled";
    let at = if settled {
        thread["settledAt"].clone()
    } else {
        Value::Null
    };
    (settled, at)
}

fn snoozed(thread: &Value, now: &str) -> (bool, Value) {
    match thread["snoozedUntil"].as_str() {
        Some(until) if until > now => (true, json!(until)),
        _ => (false, Value::Null),
    }
}

pub fn is_snoozed(thread: &Value, now: &str) -> bool {
    snoozed(thread, now).0
}

pub fn is_settled(thread: &Value) -> bool {
    settled(thread).0
}

/// `OrchestratorMcpThreadListItem` from a shell row.
pub fn list_item(config: &McpConfig, caller: &Caller, shell: &Value, now: &str) -> Value {
    let id = shell["id"].as_str().unwrap_or_default();
    let title = shell["title"].as_str().unwrap_or_default();
    let (settled, settled_at) = settled(shell);
    let (snoozed, snoozed_until) = snoozed(shell, now);
    json!({
        "threadId": id,
        "projectId": shell["projectId"],
        "title": title,
        "link": thread_link(config, caller, id, title),
        "createdBy": shell["createdBy"],
        "creationSource": shell["creationSource"],
        "status": listed_status(shell),
        "latestRunId": shell["latestRunId"],
        "providerInstanceId": shell["modelSelection"]["instanceId"],
        "model": shell["modelSelection"]["model"],
        "runtimeMode": shell["runtimeMode"],
        "interactionMode": shell["interactionMode"],
        "linkedPullRequest": shell.get("linkedPullRequest").cloned().unwrap_or(Value::Null),
        "pullRequests": open_pull_requests(&shell["pullRequests"]),
        "pullRequestCount": visible_pull_requests(&shell["pullRequests"]).count(),
        "settled": settled,
        "settledAt": settled_at,
        "snoozed": snoozed,
        "snoozedUntil": snoozed_until,
        "blockedOnThreadWait": shell["blockedOnThreadWait"] == true,
        "pendingBackgroundTasks": [],
        "parentThreadId": shell["lineage"]["parentThreadId"],
        "relationshipToParent": shell["lineage"]["relationshipToParent"],
        "itemCount": shell["visibleItemCount"].as_u64().unwrap_or(0),
        "createdAt": shell["createdAt"],
        "updatedAt": shell["updatedAt"],
    })
}

/// The status a list shows: the live run's, else the latest run's (TS `listedThreadStatus`).
pub fn listed_status(shell: &Value) -> Value {
    if shell["activityRunStatus"].is_string() {
        shell["activityRunStatus"].clone()
    } else {
        shell["status"].clone()
    }
}

/// Whether a thread read is the first page, which alone lists the thread's pull requests.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Page {
    First,
    Later,
}

/// `OrchestratorMcpThreadDetail` from a projection.
pub fn thread_detail(
    config: &McpConfig,
    caller: &Caller,
    projection: &Value,
    now: &str,
    page: Page,
) -> Value {
    let thread = &projection["thread"];
    let id = thread["id"].as_str().unwrap_or_default();
    let title = thread["title"].as_str().unwrap_or_default();
    let latest = latest_run(projection);
    let active = active_run(projection);
    let (settled, settled_at) = settled(thread);
    let (snoozed, snoozed_until) = snoozed(thread, now);
    let pending = projection["runtimeRequests"]
        .as_array()
        .map_or(0, |r| r.iter().filter(|r| r["status"] == "pending").count());
    let mut detail = json!({
        "threadId": id,
        "projectId": thread["projectId"],
        "title": title,
        "link": thread_link(config, caller, id, title),
        "createdBy": thread["createdBy"],
        "creationSource": thread["creationSource"],
        "status": active.or(latest).map_or(json!("idle"), |run| run["status"].clone()),
        "latestRunId": latest.map_or(Value::Null, |run| run["id"].clone()),
        "activeRunId": active.map_or(Value::Null, |run| run["id"].clone()),
        "providerInstanceId": thread["modelSelection"]["instanceId"],
        "model": thread["modelSelection"]["model"],
        "runtimeMode": thread["runtimeMode"],
        "interactionMode": thread["interactionMode"],
        "linkedPullRequest": thread.get("linkedPullRequest").cloned().unwrap_or(Value::Null),
        "pullRequestCount": visible_pull_requests(&thread["pullRequests"]).count(),
        "titleRegeneration": title_regeneration(&thread["titleRegeneration"]),
        "lastTitleRegeneration": if thread["lastTitleRegeneration"].is_object() {
            thread["lastTitleRegeneration"].clone()
        } else {
            Value::Null
        },
        "branch": thread["branch"],
        "worktreePath": thread["worktreePath"],
        "parentThreadId": thread["lineage"]["parentThreadId"],
        "relationshipToParent": thread["lineage"]["relationshipToParent"],
        "runCount": projection["runs"].as_array().map_or(0, Vec::len),
        "itemCount": projection["visibleTurnItems"].as_array().map_or(0, Vec::len),
        "pendingRequestCount": pending,
        "archived": !thread["archivedAt"].is_null(),
        "settled": settled,
        "settledAt": settled_at,
        "snoozed": snoozed,
        "snoozedUntil": snoozed_until,
        "blockedOnThreadWait": false,
        "pendingBackgroundTasks": [],
        "createdAt": thread["createdAt"],
        "updatedAt": projection["updatedAt"],
    });
    if page == Page::First {
        detail["pullRequests"] = open_pull_requests(&thread["pullRequests"]);
    }
    detail
}

/// `visibleThreadPullRequests`: every link but one the user dismissed from a stack.
fn visible_pull_requests(links: &Value) -> impl Iterator<Item = &Value> {
    links
        .as_array()
        .into_iter()
        .flatten()
        .filter(|link| link["source"] != "stack-dismissed")
}

/// `threadPullRequests` (`OrchestratorMcpService.ts`): the visible links that are not merged
/// or closed. The host is the link's authority or host, trimmed and lower case; the T3
/// server also maps host aliases through the source control registry, which this does not.
fn open_pull_requests(links: &Value) -> Value {
    visible_pull_requests(links)
        .filter(|link| {
            !matches!(
                link["snapshot"]["state"].as_str(),
                Some("merged" | "closed")
            )
        })
        .map(|link| {
            let host = link["authority"]
                .as_str()
                .or_else(|| link["host"].as_str())
                .unwrap_or_default()
                .trim()
                .to_lowercase();
            let watch = &link["watch"];
            json!({
                "host": host,
                "repository": link["repository"],
                "number": link["number"],
                "url": link["url"],
                "source": link["source"],
                "state": link["snapshot"]["state"].as_str().map_or(Value::Null, |s| json!(s)),
                "watching": watch.is_object(),
                "watchStartedAt": watch["startedAt"].as_str().map_or(Value::Null, |s| json!(s)),
            })
        })
        .collect()
}

/// The title regeneration in flight, as `{ requestId, startedAt }`.
fn title_regeneration(running: &Value) -> Value {
    if running.is_object() {
        json!({ "requestId": running["requestId"], "startedAt": running["startedAt"] })
    } else {
        Value::Null
    }
}

/// The model the provider reported for the run's attempt, if any.
pub fn executed_model(projection: &Value, run: &Value) -> Value {
    let attempt = &run["activeAttemptId"];
    if attempt.is_null() {
        return Value::Null;
    }
    projection["providerTurns"]
        .as_array()
        .and_then(|turns| {
            turns
                .iter()
                .rev()
                .find(|turn| &turn["attemptId"] == attempt && turn["model"].is_string())
        })
        .map_or(Value::Null, |turn| turn["model"].clone())
}

/// `OrchestratorMcpThreadRun`.
pub fn thread_run(projection: &Value, run: &Value) -> Value {
    json!({
        "runId": run["id"],
        "ordinal": run["ordinal"],
        "status": run["status"],
        "providerInstanceId": run["modelSelection"]["instanceId"],
        "model": run["modelSelection"]["model"],
        "executedModel": executed_model(projection, run),
        "requestedAt": run["requestedAt"],
        "startedAt": run["startedAt"],
        "completedAt": run["completedAt"],
    })
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

fn join(parts: &[Option<String>]) -> String {
    parts
        .iter()
        .flatten()
        .cloned()
        .collect::<Vec<_>>()
        .join("\n")
}

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

/// The text a turn item shows an agent (TS `turnItemText`).
pub fn turn_item_text(item: &Value) -> Option<String> {
    let kind = item["type"].as_str().unwrap_or_default();
    Some(match kind {
        "notification" => join(&[text(&item["summary"]), text(&item["detail"])]),
        "user_message" | "assistant_message" | "reasoning" => return text(&item["text"]),
        "proposed_plan" => return text(&item["markdown"]),
        "todo_list" => {
            let mut parts = vec![text(&item["explanation"])];
            for step in item["steps"].as_array().into_iter().flatten() {
                parts.push(Some(format!(
                    "[{}] {}",
                    step["status"].as_str().unwrap_or_default(),
                    step["text"].as_str().unwrap_or_default()
                )));
            }
            join(&parts)
        }
        "user_input_request" => pretty(&item["questions"]),
        "file_change" => {
            let counts =
                (!item["additions"].is_null() || !item["deletions"].is_null()).then(|| {
                    format!(
                        "+{} -{}",
                        item["additions"].as_u64().unwrap_or(0),
                        item["deletions"].as_u64().unwrap_or(0)
                    )
                });
            let body = text(&item["diffStr"]).or_else(|| text(&item["newStr"]));
            join(&[text(&item["fileName"]), counts, body])
        }
        "command_execution" => join(&[
            item["input"].as_str().map(|input| format!("$ {input}")),
            text(&item["output"]),
        ]),
        "file_search" => pretty(&json!({"pattern": item["pattern"], "results": item["results"]})),
        "web_search" => pretty(&json!({"patterns": item["patterns"], "results": item["results"]})),
        "approval_request" => join(&[
            text(&item["prompt"]).or_else(|| text(&item["requestKind"])),
            text(&item["reason"]),
        ]),
        "checkpoint" => pretty(&item["files"]),
        "run_interrupt_request" | "run_interrupt_result" | "system_notice" => {
            return text(&item["message"]);
        }
        "error" => return text(&item["failure"]["message"]),
        "compaction" => return text(&item["summary"]),
        "subagent" => {
            return text(&item["result"])
                .or_else(|| text(&item["progress"]))
                .or_else(|| text(&item["prompt"]));
        }
        "dynamic_tool" => pretty(&json!({
            "toolName": item["toolName"], "input": item["input"], "output": item["output"],
        })),
        _ => return None,
    })
}

/// `OrchestratorMcpThreadTimelineItem` for one visible row, its text cut to a page of
/// `max_chars` characters from `offset`.
pub fn timeline_item(row: &Value, messages: &[Value], max_chars: usize, offset: usize) -> Value {
    let item = &row["item"];
    let text = turn_item_text(item);
    let chars: Option<Vec<char>> = text.map(|t| t.chars().collect());
    let (page, truncated, next) = match &chars {
        Some(chars) => {
            let start = offset.min(chars.len());
            let end = (start + max_chars).min(chars.len());
            let truncated = end < chars.len();
            (
                Some(chars[start..end].iter().collect::<String>()),
                truncated,
                truncated.then_some(end),
            )
        }
        None => (None, false, None),
    };
    let kind = item["type"].as_str().unwrap_or_default();
    let message_id = matches!(kind, "user_message" | "assistant_message")
        .then(|| item["messageId"].clone())
        .unwrap_or(Value::Null);
    let message = messages
        .iter()
        .find(|m| !message_id.is_null() && m["id"] == message_id);
    let mut out = json!({
        "position": row["position"],
        "visibility": row["visibility"],
        "sourceThreadId": row["sourceThreadId"],
        "itemId": row["sourceItemId"],
        "runId": item["runId"],
        "messageId": message_id,
        "createdBy": message.map_or(Value::Null, |m| m["createdBy"].clone()),
        "creationSource": message.map_or(Value::Null, |m| m["creationSource"].clone()),
        "type": kind,
        "status": item["status"],
        "title": item["title"],
        "text": page,
        "textTruncated": truncated,
        "nextTextOffset": next,
        "updatedAt": item["updatedAt"],
    });
    if kind == "subagent" {
        out["subagentId"] = item["subagentId"].clone();
    }
    if let Some(sender) = message.and_then(|m| m.get("senderThreadId")) {
        out["senderThreadId"] = sender.clone();
    }
    out
}

/// The last assistant answer of a run, or its failure (TS `subagentResultForRun`).
pub fn run_result_text(projection: &Value, run_id: &str) -> Option<String> {
    let items = projection["turnItems"].as_array()?;
    items
        .iter()
        .rev()
        .filter(|item| item["runId"] == run_id)
        .find_map(|item| match item["type"].as_str() {
            Some("assistant_message") => text(&item["text"]).filter(|t| !t.is_empty()),
            Some("error") => text(&item["failure"]["message"]),
            _ => None,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pull_requests_follow_the_t3_list_rules() {
        let links = json!([
            { "host": "GitHub.com ", "repository": "a/b", "number": 1, "url": "u1", "source": "agent",
              "snapshot": { "state": "open" }, "watch": { "startedAt": "2026-01-01T00:00:00.000Z" } },
            { "host": "github.com", "repository": "a/b", "number": 2, "url": "u2", "source": "agent",
              "snapshot": { "state": "merged" } },
            { "host": "github.com", "repository": "a/b", "number": 3, "url": "u3", "source": "stack-dismissed" },
        ]);
        // The dismissed link is hidden; the merged one counts but is not listed.
        assert_eq!(visible_pull_requests(&links).count(), 2);
        assert_eq!(
            open_pull_requests(&links),
            json!([{ "host": "github.com", "repository": "a/b", "number": 1, "url": "u1",
                     "source": "agent", "state": "open", "watching": true,
                     "watchStartedAt": "2026-01-01T00:00:00.000Z" }])
        );
        assert_eq!(open_pull_requests(&Value::Null), json!([]));
        assert_eq!(title_regeneration(&Value::Null), Value::Null);
        assert_eq!(
            title_regeneration(&json!({ "requestId": "r", "startedAt": "t", "x": 1 })),
            json!({ "requestId": "r", "startedAt": "t" })
        );
    }
}
